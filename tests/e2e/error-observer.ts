import type { Frame, Page } from '@playwright/test';

export const SCREENSHOT_STYLE_HASH = 'YjaKGiklmzC6wjXA513HAMmzus8VE61XCOT+SmwNZWA=';
export const NATIVE_PDF_POLICY = "default-src 'none'; script-src resource: chrome: 'wasm-unsafe-eval'; worker-src resource:; style-src resource: chrome:; img-src resource: blob: data:; media-src blob:; font-src resource:; connect-src resource:; base-uri 'none'; form-action 'none'";
const policy = (value: string) => typeof value === 'string' ? value.trim().replace(/;$/, '') : '';
export type PageIdentity = {
  hostPageId: number; applicationPageId: number;
  scope: 'application' | 'outsideApplication'; source: 'playwright-page-identity';
};
export type ObservedError = PageIdentity & {
  id: number; capture: number | null; name: string; message: string; stack?: string;
  pageURL: string; frames: { id: number; url: string; parent: string | null }[];
};
export type Witness = PageIdentity & {
  capture: number | null; frameId: number; frameURL: string; parentURL: string | null;
  actualPdfFrame: boolean; nativePolicy: string; documentURI: string;
  blockedURI: string; effectiveDirective: string; originalPolicy: string;
  sourceFile: string; disposition: string; trusted: boolean;
  pdfProof: { url: string; mime: string; signature: string } | null;
};
export type WindowError = PageIdentity & { capture: number | null; frameURL: string; message: string; filename: string; line: number; column: number; stack?: string };
type Raw = { applicationPageId: number; errors: ObservedError[]; witnesses: Witness[]; windowErrors: WindowError[]; diagnostics: unknown[] };

function eventScope(event: Partial<PageIdentity>, applicationPageId: number) {
  if (!Number.isSafeInteger(applicationPageId) || applicationPageId < 1 ||
      event.applicationPageId !== applicationPageId || !Number.isSafeInteger(event.hostPageId) ||
      event.hostPageId! < 1 || event.source !== 'playwright-page-identity') return 'unknown';
  const expected = event.hostPageId === applicationPageId ? 'application' : 'outsideApplication';
  return event.scope === expected ? expected : 'unknown';
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Fail closed: exactly one error and one independently observed CSP witness per capture. */
export function finalizeErrors(raw: Raw) {
  const snapshot = structuredClone(raw);
  const scope = (event: Partial<PageIdentity>) => eventScope(event, snapshot.applicationPageId);
  const classifiedArtifacts: { errorId: number; witnessIndex: number; reason: string }[] = [];
  for (const error of snapshot.errors) {
    if (scope(error) !== 'application' || error.capture === null || error.name !== 'Content-Security-Policy') continue;
    const hashes = [...error.message.matchAll(/sha256-([A-Za-z0-9+/=]+)/g)].map(match => match[1]);
    if (hashes.length !== 1 || hashes[0] !== SCREENSHOT_STYLE_HASH) continue;
    const sameErrors = snapshot.errors.filter(item => item.capture === error.capture && scope(item) !== 'outsideApplication');
    const sameWitnesses = snapshot.witnesses.map((item, index) => ({ item, index })).filter(({ item }) => item.capture === error.capture && scope(item) !== 'outsideApplication');
    if (sameErrors.length !== 1 || sameWitnesses.length !== 1) continue;
    const { item: witness, index } = sameWitnesses[0]!;
    // Firefox StripURIForReporting reduces non-HTTP document URIs to the scheme.
    // Accept only exact 'blob'; the independent full-URL PDF proof remains mandatory.
    if (scope(witness) !== 'application' || !witness.actualPdfFrame || !witness.frameURL?.startsWith('blob:') ||
        (witness.documentURI !== witness.frameURL && witness.documentURI !== 'blob') || !witness.parentURL ||
        witness.pdfProof?.url !== witness.frameURL || witness.pdfProof?.mime !== 'application/pdf' || witness.pdfProof?.signature !== '%PDF-' ||
        !error.frames.some(frame => frame.id === witness.frameId && frame.url === witness.frameURL && frame.parent === witness.parentURL) ||
        error.pageURL !== witness.parentURL || policy(witness.nativePolicy) !== NATIVE_PDF_POLICY ||
        policy(witness.originalPolicy) !== NATIVE_PDF_POLICY || witness.blockedURI !== 'inline' ||
        witness.effectiveDirective !== 'style-src-elem' || witness.sourceFile !== 'blob' || witness.disposition !== 'enforce' || !witness.trusted) continue;
    classifiedArtifacts.push({ errorId: error.id, witnessIndex: index, reason: 'Playwright screenshot body {} insertion in native PDF iframe' });
  }
  const unexpectedErrors = snapshot.errors.filter(error => scope(error) !== 'outsideApplication' && !classifiedArtifacts.some(item => item.errorId === error.id));
  const unmatchedWitnesses = snapshot.witnesses.filter((witness, index) => scope(witness) !== 'outsideApplication' && !classifiedArtifacts.some(item => item.witnessIndex === index));
  const unexpectedWindowErrors = snapshot.windowErrors.filter(event => scope(event) !== 'outsideApplication');
  const outsideApplication = {
    attribution: 'UNKNOWN', validation: 'Outside the supplied application Page and its subframes',
    errors: snapshot.errors.filter(event => scope(event) === 'outsideApplication'),
    witnesses: snapshot.witnesses.filter(event => scope(event) === 'outsideApplication'),
    windowErrors: snapshot.windowErrors.filter(event => scope(event) === 'outsideApplication'),
    diagnostics: snapshot.diagnostics.filter(event => !!event && typeof event === 'object' && scope(event as PageIdentity) === 'outsideApplication'),
  };
  return deepFreeze({ ...snapshot, classifiedArtifacts, unexpectedErrors, unmatchedWitnesses, unexpectedWindowErrors, outsideApplication });
}

export function assertNoUnexpectedErrors(snapshot: ReturnType<typeof finalizeErrors>) {
  if (snapshot.unexpectedErrors.length || snapshot.unmatchedWitnesses.length || snapshot.unexpectedWindowErrors.length)
    throw new Error(`Unexpected browser diagnostics: ${snapshot.unexpectedErrors.length} page errors, ${snapshot.unmatchedWitnesses.length} CSP violations, ${snapshot.unexpectedWindowErrors.length} window errors`);
}

export async function completeErrorEvidence(steps: {
  capture: () => Promise<unknown>; dispose: () => Promise<unknown>;
  finish: () => Promise<ReturnType<typeof finalizeErrors>>;
  persist: (snapshot: ReturnType<typeof finalizeErrors>) => Promise<unknown>;
}) {
  const failures: unknown[] = [];
  try { await steps.capture(); } catch (error) { failures.push(error); }
  try { await steps.dispose(); } catch (error) { failures.push(error); }
  const snapshot = await steps.finish();
  await steps.persist(snapshot);
  assertNoUnexpectedErrors(snapshot);
  if (failures.length) throw new AggregateError(failures, 'Evidence capture or PDF cleanup failed');
  return snapshot;
}

// Runs inside each frame. Queued events are drained explicitly, without an asynchronous binding race.
function installQueue(capture: number | null) {
  const host = window as typeof window & { __qaErrors?: { capture: number | null; events: unknown[]; stop: () => void } };
  if (host.__qaErrors) { host.__qaErrors.capture = capture; return; }
  const events: unknown[] = [];
  const csp = (event: SecurityPolicyViolationEvent) => events.push({ kind: 'csp', capture: host.__qaErrors!.capture,
    documentURI: event.documentURI, blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective,
    originalPolicy: event.originalPolicy, sourceFile: event.sourceFile, disposition: event.disposition, trusted: event.isTrusted,
    violatedDirective: event.violatedDirective, lineNumber: event.lineNumber, columnNumber: event.columnNumber,
    statusCode: event.statusCode, sample: event.sample });
  const error = (event: ErrorEvent) => events.push({ kind: 'error', capture: host.__qaErrors!.capture,
    message: event.message, filename: event.filename, line: event.lineno, column: event.colno, stack: event.error?.stack,
    documentURI: document.documentURI, error: event.error ? { name: event.error.name, message: event.error.message, stack: event.error.stack } : null });
  document.addEventListener('securitypolicyviolation', csp);
  window.addEventListener('error', error);
  host.__qaErrors = { capture, events, stop: () => {
    document.removeEventListener('securitypolicyviolation', csp); window.removeEventListener('error', error);
  } };
}

export async function observeErrors(page: Page) {
  const applicationPageId = 1;
  const pageIds = new Map<Page, number>([[page, applicationPageId]]);
  const identity = (target: Page): PageIdentity => {
    if (!pageIds.has(target)) pageIds.set(target, pageIds.size + 1);
    return { hostPageId: pageIds.get(target)!, applicationPageId,
      scope: target === page ? 'application' : 'outsideApplication', source: 'playwright-page-identity' };
  };
  const raw: Raw = { applicationPageId, errors: [], witnesses: [], windowErrors: [], diagnostics: [] };
  let activeCapture: number | null = null, sequence = 0, finished = false;
  const frameIds = new Map<Frame, number>();
  const pdfProofs = new Map<string, Promise<Witness['pdfProof']>>();
  const id = (frame: Frame) => { if (!frameIds.has(frame)) frameIds.set(frame, frameIds.size + 1); return frameIds.get(frame)!; };
  const pageListeners = new Map<Page, { error: (error: Error) => void; console: (message: import('@playwright/test').ConsoleMessage) => void }>();
  const attach = (target: Page) => {
    const error = (error: Error) => raw.errors.push({ id: raw.errors.length, capture: activeCapture, name: error.name, message: error.message, stack: error.stack,
      pageURL: target.url(), frames: target.frames().map(frame => ({ id: id(frame), url: frame.url(), parent: frame.parentFrame()?.url() ?? null })), ...identity(target) });
    const console = (message: import('@playwright/test').ConsoleMessage) => raw.diagnostics.push({ kind: 'console', capture: activeCapture, pageURL: target.url(), type: message.type(), text: message.text(), location: message.location(), ...identity(target) });
    target.on('pageerror', error); target.on('console', console); pageListeners.set(target, { error, console });
  };
  for (const target of page.context().pages()) attach(target);
  page.context().on('page', attach);
  await page.context().addInitScript(installQueue, null);

  function pdfProof(frame: Frame): Promise<Witness['pdfProof']> {
    const url = frame.url(), parent = frame.parentFrame();
    if (!parent || !url.startsWith('blob:')) return Promise.resolve(null);
    if (!pdfProofs.has(url)) pdfProofs.set(url, parent.evaluate(async url => {
      // Read only the app's own immutable blob, never an external URL.
      if (new URL(url).origin !== location.origin) throw new Error('PDF blob is not same-origin');
      const response = await fetch(url);
      const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!response.ok || response.url !== url || mime !== 'application/pdf')
        throw new Error('PDF blob URL or MIME proof failed');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('PDF blob has no readable body');
      const prefix: number[] = [];
      try {
        while (prefix.length < 5) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const byte of value) { prefix.push(byte); if (prefix.length === 5) break; }
        }
      } finally { await reader.cancel(); }
      const signature = String.fromCharCode(...prefix);
      if (signature !== '%PDF-') throw new Error('PDF blob signature proof failed');
      return { url: response.url, mime, signature };
    }, url).catch(error => {
      raw.diagnostics.push({ kind: 'pdf-blob-proof-failed', frameURL: url, message: String(error), ...identity(frame.page()) });
      return null;
    }));
    return pdfProofs.get(url)!;
  }

  async function frames(capture: number | null, drain: boolean, stop = false) {
    for (const target of page.context().pages()) for (const frame of target.frames()) {
      try {
        await frame.evaluate(installQueue, capture);
        if (!drain) continue;
        const actualPdfFrame = target === page && !!frame.parentFrame() && await frame.frameElement().then(element => element.evaluate(element => element instanceof Element && element.matches('iframe.pdf-preview')));
        const proof = actualPdfFrame ? await pdfProof(frame) : null;
        const data = await frame.evaluate(stop => {
          const queue = (window as typeof window & { __qaErrors?: { events: unknown[]; stop: () => void } }).__qaErrors!;
          if (stop) queue.stop();
          return { events: queue.events.splice(0), nativePolicy: document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content ?? '' };
        }, stop);
        for (const unknownEvent of data.events) {
          const event = unknownEvent as Record<string, unknown>;
          if (event.kind === 'csp') raw.witnesses.push({ ...event, frameId: id(frame), frameURL: frame.url(), parentURL: frame.parentFrame()?.url() ?? null, actualPdfFrame, nativePolicy: data.nativePolicy, pdfProof: proof, ...identity(target) } as Witness);
          else raw.windowErrors.push({ ...event, frameURL: frame.url(), ...identity(target) } as WindowError);
        }
      } catch (error) {
        // Lost/unreadable frames cannot supply an exemption witness. Preserve the limitation.
        raw.diagnostics.push({ kind: 'frame-observation-failed', frameURL: frame.url(), message: String(error), ...identity(target) });
      }
    }
  }
  await frames(null, false);
  return {
    async capture<T>(phase: 'screenshot', operation: () => Promise<T>): Promise<T> {
      if (finished || activeCapture !== null) throw new Error('Invalid observer capture lifecycle');
      activeCapture = ++sequence;
      await frames(activeCapture, false);
      try { return await operation(); }
      finally { await frames(activeCapture, true); activeCapture = null; await frames(null, false); }
    },
    async finish() {
      if (finished || activeCapture !== null) throw new Error('Invalid observer finalization lifecycle');
      await frames(null, true, true);
      page.context().off('page', attach);
      for (const [target, listeners] of pageListeners) { target.off('pageerror', listeners.error); target.off('console', listeners.console); }
      finished = true;
      return finalizeErrors(raw);
    },
  };
}

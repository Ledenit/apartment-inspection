import { describe, expect, it } from 'vitest';
import {
  assertNoUnexpectedErrors, completeErrorEvidence, finalizeErrors,
  NATIVE_PDF_POLICY, SCREENSHOT_STYLE_HASH, type ObservedError, type Witness, type PageIdentity, type WindowError,
} from '../e2e/error-observer';

const app = 'http://127.0.0.1:4173/';
const blob = `blob:${app}synthetic-pdf`;
const applicationIdentity: PageIdentity = { hostPageId: 1, applicationPageId: 1, scope: 'application', source: 'playwright-page-identity' };
const outsideIdentity: PageIdentity = { hostPageId: 2, applicationPageId: 1, scope: 'outsideApplication', source: 'playwright-page-identity' };
function error(overrides: Partial<ObservedError> = {}): ObservedError {
  return { ...applicationIdentity, id: 0, capture: 1, name: 'Content-Security-Policy',
    message: `Blocked inline style; sha256-${SCREENSHOT_STYLE_HASH}`, stack: 'raw stack',
    pageURL: app, frames: [{ id: 2, url: blob, parent: app }], ...overrides };
}
function witness(overrides: Partial<Witness> = {}): Witness {
  return { ...applicationIdentity, capture: 1, frameId: 2, frameURL: blob, parentURL: app, actualPdfFrame: true,
    nativePolicy: NATIVE_PDF_POLICY, documentURI: blob, blockedURI: 'inline',
    effectiveDirective: 'style-src-elem', originalPolicy: NATIVE_PDF_POLICY,
    sourceFile: 'blob', disposition: 'enforce', trusted: true,
    pdfProof: { url: blob, mime: 'application/pdf', signature: '%PDF-' }, ...overrides };
}
function raw(errors = [error()], witnesses = [witness()]) {
  return { applicationPageId: 1, errors, witnesses, windowErrors: [], diagnostics: [] };
}

describe('strict screenshot artifact correlation', () => {
  it('retains raw errors and pairs one complete browser witness with one error', () => {
    const snapshot = finalizeErrors(raw());
    expect(snapshot.errors).toEqual([error()]);
    expect(snapshot.classifiedArtifacts).toHaveLength(1);
    expect(() => assertNoUnexpectedErrors(snapshot)).not.toThrow();
  });
  it.each([
    { capture: null }, { capture: 2 }, { frameId: 3 }, { frameURL: app },
    { parentURL: null }, { parentURL: 'http://other.test/' }, { actualPdfFrame: false },
    { nativePolicy: "style-src 'unsafe-inline'" }, { documentURI: 'blob:other' },
    { blockedURI: 'http://other.test' }, { effectiveDirective: 'script-src' },
    { originalPolicy: "style-src 'unsafe-inline'" }, { sourceFile: app },
    { disposition: 'report' }, { trusted: false },
  ] satisfies Partial<Witness>[] )('rejects a forged/mismatched witness %j', change => {
    const snapshot = finalizeErrors(raw([error()], [witness(change)]));
    expect(snapshot.classifiedArtifacts).toEqual([]);
    expect(() => assertNoUnexpectedErrors(snapshot)).toThrow();
  });
  it.each([
    { capture: null }, { name: 'Error' }, { message: 'Unrelated runtime exception' },
    { message: 'sha256-notTheStyleHash' }, { pageURL: 'http://other.test/' },
    { frames: [] }, { message: `sha256-${SCREENSHOT_STYLE_HASH} sha256-${SCREENSHOT_STYLE_HASH}` },
  ] satisfies Partial<ObservedError>[] )('rejects mismatched error %j', change => {
    expect(() => assertNoUnexpectedErrors(finalizeErrors(raw([error(change)])))).toThrow();
  });
  it('does not accept the exact message without an independent witness', () => {
    expect(() => assertNoUnexpectedErrors(finalizeErrors(raw([error()], [])))).toThrow();
  });
  it.each([
    null,
    { url: blob, mime: 'text/html', signature: '%PDF-' },
    { url: blob, mime: '', signature: '%PDF-' },
    { url: blob, mime: 'application/pdf', signature: '<html' },
    { url: blob, mime: 'application/pdf', signature: '' },
    { url: 'blob:http://other.test/fake', mime: 'application/pdf', signature: '%PDF-' },
    { url: '', mime: 'application/pdf', signature: '%PDF-' },
  ])('rejects a fake HTML frame or missing/mismatched blob proof %j', pdfProof => {
    const snapshot = finalizeErrors(raw([error()], [witness({ pdfProof })]));
    expect(snapshot.classifiedArtifacts).toEqual([]);
    expect(snapshot.unexpectedErrors).toHaveLength(1);
    expect(snapshot.unmatchedWitnesses).toHaveLength(1);
    expect(() => assertNoUnexpectedErrors(snapshot)).toThrow();
  });
  it('fails closed when any required witness field is missing', () => {
    for (const field of Object.keys(witness()) as (keyof Witness)[]) {
      const incomplete = witness();
      delete (incomplete as Partial<Witness>)[field];
      // Invalid runtime data must never become an accepted screenshot artifact.
      const snapshot = finalizeErrors(raw([error()], [incomplete]));
      expect(snapshot.classifiedArtifacts, field).toEqual([]);
      expect(snapshot.errors).toHaveLength(1);
      expect(() => assertNoUnexpectedErrors(snapshot), field).toThrow('Unexpected browser diagnostics');
    }
  });
  it('rejects unmatched witnesses and ambiguous multiple errors or witnesses', () => {
    for (const input of [raw([], [witness()]), raw([error(), error({ id: 1 })]),
      raw([error()], [witness(), witness()]), raw([error(), error({ id: 1 })], [witness(), witness()])]) {
      expect(() => assertNoUnexpectedErrors(finalizeErrors(input))).toThrow();
    }
  });
  it('allows multiple independent screenshot phases with one-to-one witnesses', () => {
    const snapshot = finalizeErrors(raw([error(), error({ id: 1, capture: 2 })], [witness(), witness({ capture: 2 })]));
    expect(snapshot.classifiedArtifacts).toHaveLength(2);
    expect(() => assertNoUnexpectedErrors(snapshot)).not.toThrow();
  });
  it('keeps an unknown file-viewer window error and fails conservatively', () => {
    const snapshot = finalizeErrors({ ...raw([], []), windowErrors: [{ ...applicationIdentity, capture: null, frameURL: 'file:///synthetic.pdf', message: 'ResizeObserver loop completed with undelivered notifications.', filename: '', line: 0, column: 0 }] });
    expect(snapshot.windowErrors).toHaveLength(1);
    expect(() => assertNoUnexpectedErrors(snapshot)).toThrow();
  });
  it('deeply freezes a detached snapshot without mutating its collector', () => {
    const input = raw();
    const snapshot = finalizeErrors(input);
    input.errors[0]!.frames[0]!.url = app;
    input.errors.push(error({ id: 1 }));
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0]!.frames[0]!.url).toBe(blob);
    expect(() => { snapshot.errors[0]!.frames[0]!.url = app; }).toThrow();
  });
});

describe('final evidence ordering', () => {
  it('persists and fails on an error delivered during asynchronous evidence capture', async () => {
    const input = raw([], []), order: string[] = [];
    let saved: ReturnType<typeof finalizeErrors> | undefined;
    await expect(completeErrorEvidence({
      capture: async () => { await Promise.resolve(); input.errors.push(error({ capture: null, name: 'Error', message: 'late app exception' })); order.push('capture'); },
      dispose: async () => { order.push('destroy'); },
      finish: async () => { order.push('drain/detach'); return finalizeErrors(input); },
      persist: async snapshot => { order.push('persist/attach'); saved = snapshot; },
    })).rejects.toThrow('Unexpected browser diagnostics');
    expect(order).toEqual(['capture', 'destroy', 'drain/detach', 'persist/attach']);
    expect(saved!.unexpectedErrors[0]!.message).toBe('late app exception');
    expect(JSON.parse(JSON.stringify(saved)).errors).toHaveLength(1);
  });
  it('also captures errors during PDF destroy and the final drain', async () => {
    const input = raw([], []);
    await expect(completeErrorEvidence({
      capture: async () => {},
      dispose: async () => { await Promise.resolve(); input.errors.push(error({ capture: null })); },
      finish: async () => { await Promise.resolve(); input.errors.push(error({ id: 1, capture: null })); return finalizeErrors(input); },
      persist: async snapshot => { expect(snapshot.errors).toHaveLength(2); },
    })).rejects.toThrow('2 page errors');
  });
  it('persists the same accepted snapshot that it returns and validates', async () => {
    let saved: ReturnType<typeof finalizeErrors> | undefined;
    const snapshot = await completeErrorEvidence({ capture: async () => {}, dispose: async () => {},
      finish: async () => finalizeErrors(raw()), persist: async value => { saved = value; } });
    expect(saved).toBe(snapshot);
  });
  it('still destroys, finalizes and persists when capture itself fails', async () => {
    const order: string[] = [];
    await expect(completeErrorEvidence({ capture: async () => { throw new Error('screenshot failed'); },
      dispose: async () => { order.push('destroy'); }, finish: async () => { order.push('finish'); return finalizeErrors(raw([], [])); },
      persist: async () => { order.push('persist'); },
    })).rejects.toThrow('Evidence capture or PDF cleanup failed');
    expect(order).toEqual(['destroy', 'finish', 'persist']);
  });
});

describe('Mozilla exact URI redaction', () => {
  it('accepts literal blob only with the complete independently proven PDF witness', () => {
    const snapshot = finalizeErrors(raw([error()], [witness({ documentURI: 'blob' })]));
    expect(snapshot.classifiedArtifacts).toHaveLength(1);
    expect(snapshot.witnesses[0]!.documentURI).toBe('blob');
    expect(snapshot.witnesses[0]!.pdfProof!.url).toBe(blob);
    expect(() => assertNoUnexpectedErrors(snapshot)).not.toThrow();
  });
  it.each(['', 'blob:', 'blob:other', 'blob:anything', 'blob ', 'Blob', 'BLOB', ' blob', app, 'data'])('rejects unsupported redaction %j', documentURI => {
    expect(() => assertNoUnexpectedErrors(finalizeErrors(raw([error()], [witness({ documentURI })])))).toThrow();
  });
  it.each([
    { pdfProof: null }, { actualPdfFrame: false }, { trusted: false }, { frameId: 9 },
    { nativePolicy: '' }, { originalPolicy: '' }, { capture: 2 },
    { pdfProof: { url: 'blob:other', mime: 'application/pdf', signature: '%PDF-' } },
  ] satisfies Partial<Witness>[])('does not weaken other gates for redacted blob %j', change => {
    expect(() => assertNoUnexpectedErrors(finalizeErrors(raw([error()], [witness({ documentURI: 'blob', ...change })])))).toThrow();
  });
});

describe('host Page identity defines the application validation surface', () => {
  const resize: WindowError = { ...applicationIdentity, capture: null, frameURL: 'file:///synthetic.pdf', message: 'ResizeObserver loop completed with undelivered notifications.', filename: '', line: 0, column: 0 };
  it('preserves separate-page events as outsideApplication UNKNOWN without claiming them clean', () => {
    const outsideWindowError = { ...resize, ...outsideIdentity };
    const snapshot = finalizeErrors({ ...raw([error(outsideIdentity)], [witness(outsideIdentity)]), windowErrors: [outsideWindowError], diagnostics: [{ ...outsideIdentity, text: 'raw separate-page console' }] });
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.witnesses).toHaveLength(1);
    expect(snapshot.windowErrors).toEqual([outsideWindowError]);
    expect(snapshot.outsideApplication.attribution).toBe('UNKNOWN');
    expect(snapshot.outsideApplication.errors).toHaveLength(1);
    expect(snapshot.outsideApplication.witnesses).toHaveLength(1);
    expect(snapshot.outsideApplication.windowErrors).toHaveLength(1);
    expect(snapshot.outsideApplication.diagnostics).toHaveLength(1);
    expect(snapshot.classifiedArtifacts).toEqual([]);
    expect(() => assertNoUnexpectedErrors(snapshot)).not.toThrow();
  });
  it.each([app, 'file:///synthetic.pdf', blob])('fails the identical ResizeObserver on supplied Page regardless of URL %s', frameURL => {
    const snapshot = finalizeErrors({ ...raw([], []), windowErrors: [{ ...resize, frameURL }] });
    expect(snapshot.outsideApplication.windowErrors).toEqual([]);
    expect(() => assertNoUnexpectedErrors(snapshot)).toThrow('1 window errors');
  });
  it('does not let an outside Page supply an application error witness', () => {
    expect(() => assertNoUnexpectedErrors(finalizeErrors(raw([error()], [witness(outsideIdentity)])))).toThrow();
    expect(() => assertNoUnexpectedErrors(finalizeErrors(raw([error(outsideIdentity)], [witness()])))).toThrow();
  });
  it.each(['hostPageId', 'applicationPageId', 'scope', 'source'] as const)('fails all event classes with missing identity field %s', key => {
    const incomplete = { ...outsideIdentity };
    delete (incomplete as Partial<PageIdentity>)[key];
    const pageError = { ...error(), ...incomplete };
    const csp = { ...witness(), ...incomplete };
    const windowError = { ...resize, ...incomplete };
    delete (pageError as Partial<PageIdentity>)[key];
    delete (csp as Partial<PageIdentity>)[key];
    delete (windowError as Partial<PageIdentity>)[key];
    for (const input of [raw([pageError], []), raw([], [csp]), { ...raw([], []), windowErrors: [windowError] }]) {
      expect(() => assertNoUnexpectedErrors(finalizeErrors(input))).toThrow();
    }
  });
  it.each([
    { hostPageId: 1, scope: 'outsideApplication' }, { hostPageId: 2, scope: 'application' },
    { applicationPageId: 9 }, { hostPageId: 0 }, { hostPageId: NaN }, { source: 'event-payload' },
  ])('fails ambiguous or untrusted scope metadata %j', change => {
    const event = { ...resize, ...outsideIdentity, ...change } as WindowError;
    expect(() => assertNoUnexpectedErrors(finalizeErrors({ ...raw([], []), windowErrors: [event] }))).toThrow();
  });
});

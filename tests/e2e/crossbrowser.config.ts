import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir:'.',testMatch:'crossbrowser.spec.ts',timeout:120_000,expect:{timeout:8000},
  fullyParallel:false,workers:1,retries:0,
  reporter:[['list'],['json',{outputFile:'test-results/crossbrowser-results.json'}]],
  use:{baseURL:'http://127.0.0.1:4173',locale:'ru-RU',timezoneId:'Asia/Yekaterinburg',viewport:{width:430,height:887},trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[
    {name:'edge-installed',use:{browserName:'chromium',launchOptions:{executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}}},
    // Stock Firefox BiDi first attempt is archived separately; use Playwright's patched Firefox for supported automation.
    {name:'firefox-managed',use:{browserName:'firefox'}},
    {name:'webkit-managed-persistent',use:{browserName:'webkit'}},
  ],
  webServer:{command:process.env.QA_BUILT_APP==='1'?'npm run preview -- --port 4173 --strictPort':'npm run dev -- --port 4173 --strictPort',url:'http://127.0.0.1:4173',reuseExistingServer:process.env.QA_BUILT_APP!=='1',timeout:30_000},
});

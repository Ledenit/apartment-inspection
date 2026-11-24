import {defineConfig} from '@playwright/test';
import base from './crossbrowser.config';

export default defineConfig({...base,projects:[
  {name:'firefox-installed-bidi-realkeys',use:{browserName:'firefox',launchOptions:{channel:'moz-firefox',executablePath:'C:/Program Files/Mozilla Firefox/firefox.exe'}}},
]});

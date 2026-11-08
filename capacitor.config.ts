import type { CapacitorConfig } from '@capacitor/cli';
const appUrl = process.env['CAPACITOR_APP_URL'];
if (appUrl && (!appUrl.startsWith('https://') || appUrl.includes('id-preview--'))) throw new Error('CAPACITOR_APP_URL must be the published HTTPS app URL, not the editor preview');
const config: CapacitorConfig = {
  appId: 'com.globalnetworks.app', appName: 'Global Networks', webDir: 'native-web',
  ...(appUrl ? { server: { url: appUrl, cleartext: false } } : {}),
  android: { allowMixedContent: false },
};
export default config;

/**
 * Reference Faro Web SDK initializer.
 *
 * Copy this file into a consuming site and fill in APP_NAME / APP_VERSION.
 * Designed for plain <script> use (no bundler) on static sites. For React/Vite
 * projects, swap the CDN loader for `npm i @grafana/faro-web-sdk @grafana/faro-web-tracing`
 * and call `initializeFaro` directly.
 *
 * SDK versions are pinned to a minor range (^1.4.0) so upstream majors can't
 * silently break production. Bump deliberately after validating in dev.
 */
(function () {
  const APP_NAME = 'REPLACE_ME';          // e.g. 'subscribe' | 'game-finder' | 'sb1-overlay'
  const APP_VERSION = '1.0.0';            // consider wiring to your build/git SHA
  const PROXY_ORIGIN = 'https://grafana.michaellamb.dev';
  const SDK_VERSION = '^1.4.0';

  const isLocalDev =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  const faroUrl = isLocalDev
    ? `http://localhost:8787/faro-proxy?app=${APP_NAME}`
    : `${PROXY_ORIGIN}/faro-proxy?app=${APP_NAME}`;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  loadScript(`https://unpkg.com/@grafana/faro-web-sdk@${SDK_VERSION}/dist/bundle/faro-web-sdk.iife.js`)
    .then(() => {
      window.GrafanaFaroWebSdk.initializeFaro({
        url: faroUrl,
        app: {
          name: APP_NAME,
          version: APP_VERSION,
          environment: isLocalDev ? 'development' : 'production',
        },
      });
      return loadScript(
        `https://unpkg.com/@grafana/faro-web-tracing@${SDK_VERSION}/dist/bundle/faro-web-tracing.iife.js`
      );
    })
    .then(() => {
      window.GrafanaFaroWebSdk.faro.instrumentations.add(
        new window.GrafanaFaroWebTracing.TracingInstrumentation()
      );
    })
    .catch((err) => {
      // Never let telemetry init break the page.
      // eslint-disable-next-line no-console
      console.warn('Faro init failed:', err);
    });
})();

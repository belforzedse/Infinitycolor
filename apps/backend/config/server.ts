export default ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  app: {
    keys: env.array('APP_KEYS'),
  },
  // Sets the Koa `app.proxy` flag. When true, Strapi trusts reverse-proxy headers
  // (`X-Forwarded-For`, `X-Forwarded-Proto`, …) so `ctx.request.ip` resolves to the real client
  // instead of the nginx→Strapi hop / Docker bridge gateway. The deployment always sits behind
  // nginx (a trusted proxy that sets these headers), so this defaults to true; set IS_PROXIED=false
  // only if Strapi is ever exposed directly (so spoofed headers aren't trusted).
  proxy: env.bool('IS_PROXIED', true),
  webhooks: {
    populateRelations: env.bool('WEBHOOKS_POPULATE_RELATIONS', false),
  },

});

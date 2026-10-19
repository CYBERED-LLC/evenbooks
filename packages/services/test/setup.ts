// Test-only defaults so the suite is self-contained: public links, bank
// connections and processor tokens need an encryption key at rest.
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

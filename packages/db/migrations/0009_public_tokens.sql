-- 0009_public_tokens
-- Public invoice links: the token is stored hashed (lookup) and encrypted
-- (so the same link can be re-sent). Plaintext is never stored.

ALTER TABLE invoices ADD COLUMN public_token_ciphertext text;

SELECT app.grant_app_privileges();

/*
# Enable RLS on all Synoma tables

The app uses its own session/cookie auth system (not Supabase Auth).
The server-side code connects with the `synoma_app` role which has BYPASSRLS.
This satisfies the Supabase requirement that all tables have RLS enabled,
while allowing the app's server to perform all CRUD operations.

1. Security
- Enable RLS on all tables.
- The `synoma_app` role has BYPASSRLS so the server can read/write.
- No anon/authenticated policies needed: the browser never talks to the DB directly.
*/

ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE codigos_acceso ENABLE ROW LEVEL SECURITY;
ALTER TABLE sesiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensajes ENABLE ROW LEVEL SECURITY;
ALTER TABLE uso_diario ENABLE ROW LEVEL SECURITY;
ALTER TABLE piezas ENABLE ROW LEVEL SECURITY;
ALTER TABLE migraciones ENABLE ROW LEVEL SECURITY;

-- Grant BYPASSRLS to the app role
ALTER ROLE synoma_app BYPASSRLS;

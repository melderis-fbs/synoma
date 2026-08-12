/*
# Chat attachments storage bucket

1. Storage
- Creates a private bucket `chat-attachments` for files uploaded from the chat
  (images, PDFs, CSVs, Excel). Files are stored privately and only the edge
  function (service role) can read them — the browser uploads with a scoped
  path and then sends the path to the edge function, which downloads the file
  server-side.

2. Policies
- INSERT: authenticated users (via anon key with session) can upload to a
  path prefixed with their cliente_id. We use a folder convention:
  `chat/<cliente_id>/<uuid>.<ext>`.
- SELECT: deny from the browser — only the service role (edge function)
  reads files. No SELECT policy means anon/authenticated cannot read.
- DELETE: same — only service role cleans up.

3. Notes
- The bucket is PRIVATE (not public). Files are never exposed to the browser.
- The edge function uses the SERVICE_ROLE_KEY to fetch uploaded files, which
  bypasses RLS.
- The frontend gets the cliente_id from the session (stored in localStorage
  as synoma_cliente). We pass it as a header or in the upload path.
*/

INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-attachments', 'chat-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload files scoped to their cliente_id folder.
-- The path convention is: chat/<cliente_id>/<filename>
DROP POLICY IF EXISTS "users_upload_own_attachments" ON storage.objects;
CREATE POLICY "users_upload_own_attachments"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (
  bucket_id = 'chat-attachments'
  AND (storage.foldername(name))[1] = 'chat'
  AND (storage.foldername(name))[2] = auth.uid()::text
);

-- Allow the service role (edge function) to read and delete. Since the edge
-- function uses SERVICE_ROLE_KEY it bypasses RLS entirely, so we don't
-- strictly need these policies. But we add a deny for anon/authenticated to
-- be explicit that browsers cannot read files directly.
-- No SELECT or DELETE policy for anon/authenticated = denied by default.
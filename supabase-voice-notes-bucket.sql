-- supabase-voice-notes-bucket.sql
-- RecallFox PWA v1.8.0: Buat Storage bucket `voice-notes` + tambah kolom `source` JSONB ke notes table.
--
-- Cara pakai:
--   1. Buka Supabase Dashboard: https://supabase.com/dashboard/project/qmwofsfpxjptpyvncylp/sql
--   2. Klik "New query"
--   3. Paste seluruh isi file ini
--   4. Klik "Run" (Ctrl+Enter)
--   5. Verifikasi: cek di Storage → bucket `voice-notes` harus ada
--      dan di Table Editor → notes → kolom `source` (jsonb) harus ada
--
-- Setelah run: bucket + kolom siap dipakai. PWA v1.8.0 akan upload audio ke sini
-- dan simpan metadata di notes.source. Addon v3.19.1+ akan baca notes.source.audioUrl
-- → playback via <audio>.

-- ============================================================
-- PART 1: Storage bucket `voice-notes`
-- ============================================================

-- 1. Buat bucket (public-readable, sama seperti `screenshots`)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'voice-notes',
  'voice-notes',
  true,                                  -- public: siapa saja bisa baca via URL
  26214400,                              -- 25 MB max (audio pendek 1-2 menit)
  ARRAY['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/mpeg']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 2. RLS Policies (sama pattern dengan `screenshots`)
--    - Public read: siapa saja bisa baca via public URL (untuk playback di PWA & addon)
--    - Auth write: user hanya bisa upload/hapus file di folder sendiri (user_id/<item_id>.ext)

-- Policy: authenticated users bisa upload ke folder user_id mereka sendiri
CREATE POLICY "voice_notes_upload_own"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'voice-notes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: public bisa baca (untuk playback via public URL)
CREATE POLICY "voice_notes_read_public"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'voice-notes');

-- Policy: user bisa hapus file mereka sendiri
CREATE POLICY "voice_notes_delete_own"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'voice-notes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: user bisa update file mereka sendiri (untuk upsert)
CREATE POLICY "voice_notes_update_own"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'voice-notes'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================
-- PART 2: Tambah kolom `source` JSONB ke notes table
-- ============================================================
-- Untuk simpan metadata voice note (audioUrl, duration, kind, location, dll)
-- Tanpa kolom ini, voice note tidak punya tempat simpan audio URL.

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS source jsonb DEFAULT NULL;

-- Comment untuk dokumentasi
COMMENT ON COLUMN notes.source IS 'v1.8.0: JSONB untuk metadata tambahan. Voice notes: {kind:"voice", audioUrl:"...", duration:sec, location:{...}}';

-- ============================================================
-- PART 3: Verifikasi
-- ============================================================

-- 3a. Verifikasi bucket
SELECT
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
FROM storage.buckets
WHERE id = 'voice-notes';

-- 3b. Verifikasi policies
SELECT
  tablename,
  policyname,
  cmd,
  roles
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
  AND policyname LIKE 'voice_notes_%'
ORDER BY policyname;

-- 3c. Verifikasi kolom source di notes
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'notes'
  AND column_name = 'source';

-- Expected output:
-- - 1 row di buckets: id='voice-notes', public=true, file_size_limit=26214400
-- - 4 rows di policies: voice_notes_upload_own, voice_notes_read_public, voice_notes_delete_own, voice_notes_update_own
-- - 1 row di columns: column_name='source', data_type='jsonb', is_nullable='YES'

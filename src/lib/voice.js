// src/lib/voice.js — Rekam suara via MediaRecorder + upload ke Supabase Storage
// v1.8.0: Voice notes untuk PWA. Addon tidak rekam, hanya playback via <audio>.
//
// Storage: Supabase bucket `voice-notes` (public-readable, sama seperti `screenshots`).
// Schema: bucket ini harus dibuat manual oleh user via SQL migration (lihat
// supabase-voice-notes-bucket.sql di root project).
//
// Item schema:
//   type: 'note'
//   note_kind: 'voice'  (kolom baru di notes table, atau pakai source.kind)
//   source: {
//     kind: 'voice',
//     audioUrl: 'https://...supabase.co/storage/v1/object/public/voice-notes/<id>.webm',
//     duration: number (seconds),
//     capturedAt: ISO string,
//     device: 'pwa-mobile'
//   }
//
// Kompatibel dengan addon: addon baca source.audioUrl → tampilkan <audio controls>.

import { supabase } from '../supabase.js';
import { reverseGeocode } from './location.js';

const VOICE_BUCKET = 'voice-notes';
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',  // Chrome/Firefox default
  'audio/webm',
  'audio/mp4',               // Safari/iOS
  'audio/ogg;codecs=opus'
];

let _mediaRecorder = null;
let _chunks = [];
let _stream = null;
let _startTime = 0;
let _timerInterval = null;

/**
 * Check apakah browser support MediaRecorder.
 */
export function isVoiceRecordingSupported() {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Start recording audio from microphone.
 * Returns { ok, mimeType } atau { ok: false, error }.
 *
 * @param {function} onTick - callback(durationSec) setiap 100ms untuk update UI timer
 */
export async function startRecording(onTick) {
  if (!isVoiceRecordingSupported()) {
    return { ok: false, error: 'browser_tidak_mendukung_rekaman' };
  }
  if (_mediaRecorder && _mediaRecorder.state === 'recording') {
    return { ok: false, error: 'sudah_merekam' };
  }

  try {
    _stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    console.warn('[RecallFox] getUserMedia error:', e.message);
    return { ok: false, error: 'izin_mic_ditolak' };
  }

  // Pick best supported mimeType
  const mimeType = MIME_CANDIDATES.find(m => MediaRecorder.isTypeSupported(m)) || '';
  try {
    _mediaRecorder = new MediaRecorder(_stream, mimeType ? { mimeType } : undefined);
  } catch (e) {
    console.warn('[RecallFox] MediaRecorder init error:', e.message);
    stopStream();
    return { ok: false, error: 'media_recorder_init_gagal' };
  }

  _chunks = [];
  _mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) _chunks.push(e.data);
  };

  _startTime = Date.now();
  if (onTick) {
    _timerInterval = setInterval(() => {
      const sec = (Date.now() - _startTime) / 1000;
      onTick(sec);
    }, 100);
  }

  _mediaRecorder.start(1000);  // collect data every 1s
  return { ok: true, mimeType: _mediaRecorder.mimeType || mimeType };
}

/**
 * Stop recording and return blob + duration.
 * Returns { ok, blob, mimeType, durationSec } atau { ok: false, error }.
 */
export function stopRecording() {
  return new Promise((resolve) => {
    if (!_mediaRecorder) {
      resolve({ ok: false, error: 'tidak_ada_recorder_aktif' });
      return;
    }
    const durationSec = (Date.now() - _startTime) / 1000;
    const mimeType = _mediaRecorder.mimeType || 'audio/webm';

    _mediaRecorder.onstop = () => {
      const blob = new Blob(_chunks, { type: mimeType });
      stopStream();
      clearInterval(_timerInterval);
      _timerInterval = null;
      _mediaRecorder = null;
      _chunks = [];
      resolve({ ok: true, blob, mimeType, durationSec });
    };

    try {
      _mediaRecorder.stop();
    } catch (e) {
      stopStream();
      resolve({ ok: false, error: 'stop_gagal: ' + e.message });
    }
  });
}

/**
 * Cancel recording (discard audio).
 */
export function cancelRecording() {
  if (_mediaRecorder && _mediaRecorder.state === 'recording') {
    try { _mediaRecorder.stop(); } catch (e) {}
  }
  stopStream();
  clearInterval(_timerInterval);
  _timerInterval = null;
  _mediaRecorder = null;
  _chunks = [];
}

function stopStream() {
  if (_stream) {
    _stream.getTracks().forEach(t => t.stop());
    _stream = null;
  }
}

/**
 * Upload audio blob to Supabase Storage.
 * Returns public URL atau null jika gagal.
 *
 * @param {Object} user - supabase user
 * @param {string} itemId - note id (for predictable path)
 * @param {Blob} blob
 * @param {string} mimeType
 * @returns {Promise<{ok, url?, error?}>}
 */
export async function uploadVoiceBlob(user, itemId, blob, mimeType) {
  if (!user || !blob || !itemId) {
    return { ok: false, error: 'invalid_args' };
  }
  // Determine file extension from mimeType
  let ext = 'webm';
  if (mimeType.includes('mp4')) ext = 'm4a';
  else if (mimeType.includes('ogg')) ext = 'ogg';
  else if (mimeType.includes('wav')) ext = 'wav';
  const path = `${user.id}/${itemId}.${ext}`;

  try {
    const { error } = await supabase.storage
      .from(VOICE_BUCKET)
      .upload(path, blob, {
        contentType: mimeType,
        cacheControl: '3600',
        upsert: true
      });
    if (error) {
      console.warn('[RecallFox] Voice upload failed:', error.message);
      return { ok: false, error: error.message };
    }
    // Get public URL
    const { data: urlData } = supabase.storage
      .from(VOICE_BUCKET)
      .getPublicUrl(path);
    if (!urlData?.publicUrl) {
      return { ok: false, error: 'no_public_url' };
    }
    return { ok: true, url: urlData.publicUrl };
  } catch (e) {
    console.warn('[RecallFox] Voice upload exception:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Delete voice blob from Supabase Storage (saat hapus note).
 */
export async function deleteVoiceBlob(user, itemId) {
  if (!user || !itemId) return { ok: false, error: 'invalid_args' };
  // Try common extensions
  for (const ext of ['webm', 'm4a', 'ogg', 'wav']) {
    const path = `${user.id}/${itemId}.${ext}`;
    try {
      const { error } = await supabase.storage
        .from(VOICE_BUCKET)
        .remove([path]);
      if (!error) return { ok: true };
    } catch (e) {}
  }
  return { ok: false, error: 'not_found' };
}

/**
 * Format duration untuk display.
 * 65 → "1:05", 3600 → "60:00"
 */
export function formatDuration(sec) {
  if (!sec || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

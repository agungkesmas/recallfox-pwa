# v1.20.1 — RETRY UPLOAD SEMENTARA (500 intermiten)

Port 1:1 `lib/temp-upload.js` addon v3.24.16: retry maks 3x untuk network/5xx
(backoff 1s/2s/4s). PWA test 10/10 tetap lolos (API kompatibel mundur).

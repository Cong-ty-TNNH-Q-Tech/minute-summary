/**
 * Test script: kiểm tra transcription pipeline độc lập với Discord
 * Chạy: node test-transcription.js
 *
 * Script này sẽ:
 * 1. Tạo file MP3 test bằng ffmpeg (1 giây silence + beep)
 * 2. Gọi thẳng nodewhisper để transcribe
 * 3. In kết quả ra console
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { nodewhisper } = require('nodejs-whisper');
const ffmpeg = require('ffmpeg-static');

const TEST_DIR = path.join(__dirname, 'meetings', '_test');
const TEST_MP3 = path.join(TEST_DIR, '_test.mp3');
const MODEL = 'medium';
const LANGUAGE = 'vi';

// Tạo thư mục test
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });

console.log('=== Transcription Test ===');
console.log(`ffmpeg path: ${ffmpeg}`);
console.log(`test mp3: ${TEST_MP3}`);
console.log('');

// Bước 1: Tạo file MP3 test (3 giây sine wave 440Hz)
console.log('[Step 1] Generating test MP3 (3 seconds, 440Hz tone)...');
const genProc = spawn(ffmpeg, [
  '-f', 'lavfi',
  '-i', 'sine=frequency=440:duration=3',
  '-codec:a', 'libmp3lame',
  '-q:a', '2',
  '-y',
  TEST_MP3,
]);

genProc.stderr.on('data', () => {}); // suppress ffmpeg output

genProc.on('close', async (code) => {
  if (code !== 0) {
    console.error('[Step 1] FAILED: could not generate test MP3');
    process.exit(1);
  }

  const sizeMB = (fs.statSync(TEST_MP3).size / 1024).toFixed(2);
  console.log(`[Step 1] OK — MP3 size: ${sizeMB} KB`);
  console.log('');

  // Bước 2: Chạy nodewhisper
  console.log('[Step 2] Running nodewhisper transcription...');
  console.log(`         Model: ${MODEL}, Language: ${LANGUAGE}`);
  console.log('         (Lần đầu sẽ download model ~1.5GB — hãy chờ)\n');

  try {
    const text = await nodewhisper(TEST_MP3, {
      modelName: MODEL,
      autoDownloadModelName: MODEL,
      verbose: true,
      removeWavFileAfterTranscription: false,
      withCuda: false,
      whisperOptions: {
        outputInText: true,
        language: LANGUAGE,
      },
    });

    console.log('\n=== RESULT ===');
    if (text && text.trim()) {
      console.log('Transcription:', text);
    } else {
      console.log('Transcription: (empty — expected for a tone, not speech)');
      console.log('✅ Pipeline OK — nodewhisper ran without errors');
    }
  } catch (err) {
    console.error('\n=== ERROR ===');
    console.error(err.message);
    process.exit(1);
  } finally {
    // Cleanup
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    console.log('\n[Cleanup] Test files removed.');
  }
});

/**
 * Local Whisper transcription via a containerized faster-whisper instance.
 * Downloads audio from a URL, runs the whisper container, returns text.
 * Zero API cost — runs entirely on local CPU.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { WHISPER_IMAGE, WHISPER_TIMEOUT } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { logger } from './logger.js';

interface TranscriptionResult {
  text: string;
  language: string;
  duration: number;
}

/**
 * Download audio from a URL, transcribe it using the local Whisper container,
 * and return the transcription text. Returns null on any failure.
 *
 * Optional `authHeader` lets channels (e.g. Slack) pass a Bearer token —
 * Slack's `url_private` requires `Authorization: Bearer xoxb-...`.
 */
export async function transcribeAudio(
  url: string,
  authHeader?: string,
): Promise<string | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-whisper-'));
  const tmpFile = path.join(tmpDir, 'audio');

  try {
    const response = await fetch(
      url,
      authHeader ? { headers: { Authorization: authHeader } } : undefined,
    );
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tmpFile, buffer);

    // 2. Run whisper container: mount tmpDir read-only, transcribe, exit
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        CONTAINER_RUNTIME_BIN,
        [
          'run', '--rm',
          '-v', `${tmpDir}:/audio:ro`,
          WHISPER_IMAGE,
          '/audio/audio',
        ],
        { timeout: WHISPER_TIMEOUT, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            logger.warn({ err: err.message, stderr }, 'Whisper container failed');
            reject(err);
            return;
          }
          resolve(stdout.trim());
        },
      );
    });

    // 3. Parse JSON output from the container
    const parsed: TranscriptionResult = JSON.parse(stdout);
    const text = parsed.text?.trim();
    if (!text) return null;

    logger.info(
      { language: parsed.language, duration: parsed.duration, chars: text.length },
      'Audio transcribed',
    );
    return text;
  } catch (err) {
    logger.warn({ err, url: url.slice(0, 80) }, 'Audio transcription failed');
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

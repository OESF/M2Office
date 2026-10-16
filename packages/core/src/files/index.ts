/**
 * @file ファイルの置き場と、PDF・Excel・CSV・Word を扱う部品の公開窓口（帳票の PDF 出力と、2 つの版の比べ方を含む）。
 *
 * @see 仕様書 第9.4.1節 文書を扱う共通ツール
 */

export { LocalFileStore, MemoryFileStore, fileReader, type FileStore } from './store.js';
export { detectKind, MIME, MAX_FILE_BYTES, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, AUDIO_KINDS, isAudioKind, isAudioName, type FileKind } from './formats.js';
export { saveFile, loadFile } from './service.js';
export { readSheet, renderSheet, parseCsv, decodeText, csvSafeText, csvText, type SheetData } from './sheet.js';
export { extractPdfText, normalizeRadicals, type PdfText } from './pdf.js';
export { renderDocx, extractDocxText, type DocBlock } from './docx.js';
export { fileToText, TEXT_LIMIT, TRANSCRIPT_NOTE, type FileText, type OcrFn, type TranscribeFn } from './to-text.js';
export { transcribeRecording, TranscribeError, TRANSCRIBE_SEGMENT_SEC, clockOf, shiftTimes, speakersOf, type Transcript, type TranscribeDeps } from './transcribe.js';
export { discardStaleRecordings, RECORDING_UNUSED_MS } from './recordings.js';
export {
  startLiveRecording, putLiveRecordingPart, finishLiveRecording, discardLiveRecording, discardStaleLiveRecordings, liveRecordingName, liveSeconds, wavHeader,
  LiveRecordingError, LIVE_SAMPLE_RATE, LIVE_PART_MAX_BYTES, LIVE_MAX_BYTES, LIVE_RECORDING_STALE_MS,
} from './live-recording.js';
export { audioDurationSec, estimateDurationSec, splitAudio, type AudioSegment } from '../media/audio.js';
export { compareTexts, splitClauses, type Clause, type ClauseChange, type Comparison } from './compare.js';
export {
  renderPdf, rowAmount, yen, missingCharacters, extractPages, REPLACEMENT, OCR_MAX_PAGES,
  type InvoiceDoc, type InvoiceRow,
} from './pdf-render.js';

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, mock, test } from 'node:test'

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'duix-voice-test-'))
after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }))
const assetPath = {
  model: path.join(temporaryDirectory, 'model'),
  ttsRoot: path.join(temporaryDirectory, 'tts'),
  ttsTrain: path.join(temporaryDirectory, 'tts', 'origin_audio')
}
const ipcHandlers = new Map()
const insertVoice = mock.fn(() => 42)
const insertModel = mock.fn(() => 73)
const preprocessAndTrain = mock.fn(async () => ({
  code: -1,
  msg: 'ASR service is unavailable'
}))

mock.module(new URL('../dao/voice.js', import.meta.url), {
  namedExports: {
    insert: insertVoice,
    selectAll: mock.fn(),
    selectByID: mock.fn()
  }
})
mock.module(new URL('../api/tts.js', import.meta.url), {
  namedExports: {
    makeAudio: mock.fn(),
    preprocessAndTran: preprocessAndTrain
  }
})
mock.module(new URL('../config/config.js', import.meta.url), {
  namedExports: {
    assetPath
  }
})
mock.module(new URL('../logger.js', import.meta.url), {
  defaultExport: {
    debug: mock.fn(),
    error: mock.fn()
  }
})
mock.module('electron', {
  namedExports: {
    ipcMain: { handle: (name, handler) => ipcHandlers.set(name, handler) }
  }
})
mock.module('dayjs', {
  defaultExport: () => ({ format: () => '20260929000100000' })
})
mock.module('lodash', {
  namedExports: { isEmpty: mock.fn() }
})
mock.module(new URL('../dao/f2f-model.js', import.meta.url), {
  namedExports: {
    insert: insertModel,
    selectPage: mock.fn(),
    count: mock.fn(),
    selectByID: mock.fn(),
    remove: mock.fn()
  }
})
mock.module(new URL('../util/ffmpeg.js', import.meta.url), {
  namedExports: {
    extractAudio: async () => {},
    toH264: async () => {}
  }
})

const { train } = await import('./voice.js')
const { init } = await import('./model.js')
init()
const addModel = ipcHandlers.get('model/addModel')

beforeEach(() => {
  insertVoice.mock.resetCalls()
  insertModel.mock.resetCalls()
  preprocessAndTrain.mock.resetCalls()
  preprocessAndTrain.mock.mockImplementation(async () => ({
    code: -1,
    msg: 'ASR service is unavailable'
  }))
})

test('train propagates the backend error without inserting a voice record', async () => {
  await assert.rejects(train('origin_audio/test.wav', 'zh'), /ASR service is unavailable/)
  assert.equal(insertVoice.mock.callCount(), 0)
})

for (const msg of [undefined, '']) {
  test(`train reports the backend code when its message is ${JSON.stringify(msg)}`, async () => {
    preprocessAndTrain.mock.mockImplementation(async () => ({ code: 503, msg }))
    await assert.rejects(train('origin_audio/test.wav'), /Voice training failed.*503/)
    assert.equal(insertVoice.mock.callCount(), 0)
  })
}

test('train preserves a transport rejection without inserting a voice record', async () => {
  const networkError = new Error('connection refused')
  preprocessAndTrain.mock.mockImplementation(async () => {
    throw networkError
  })
  await assert.rejects(train('origin_audio/test.wav'), (error) => error === networkError)
  assert.equal(insertVoice.mock.callCount(), 0)
})

test('train stores the successful response and returns the voice identifier', async () => {
  preprocessAndTrain.mock.mockImplementation(async () => ({
    code: 0,
    asr_format_audio_url: 'processed/reference.wav',
    reference_audio_text: 'hello world'
  }))
  assert.equal(await train('origin_audio\\sample.wav', 'en'), 42)
  assert.deepEqual(preprocessAndTrain.mock.calls[0].arguments, [
    {
      format: 'wav',
      reference_audio: 'origin_audio/sample.wav',
      lang: 'en'
    }
  ])
  assert.deepEqual(insertVoice.mock.calls[0].arguments, [
    {
      origin_audio_path: 'origin_audio/sample.wav',
      lang: 'en',
      asr_format_audio_url: 'processed/reference.wav',
      reference_audio_text: 'hello world'
    }
  ])
  assert.equal(insertVoice.mock.callCount(), 1)
})

test('model creation propagates training failure before either database insert', async () => {
  await assert.rejects(addModel(null, 'demo', '/input/demo.mp4'), /ASR service is unavailable/)
  assert.equal(preprocessAndTrain.mock.callCount(), 1)
  assert.equal(insertVoice.mock.callCount(), 0)
  assert.equal(insertModel.mock.callCount(), 0)
})

test('model creation stores the trained voice identifier on success', async () => {
  preprocessAndTrain.mock.mockImplementation(async () => ({
    code: 0,
    asr_format_audio_url: 'processed/reference.wav',
    reference_audio_text: 'hello world'
  }))
  assert.equal(await addModel(null, 'demo', '/input/demo.mp4'), 73)
  assert.equal(insertVoice.mock.callCount(), 1)
  assert.equal(insertModel.mock.callCount(), 1)
  assert.equal(insertModel.mock.calls[0].arguments[0].voiceId, 42)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { detectLanguage } from '../src/detect.ts'

test('中文', () => assert.equal(detectLanguage('今天天气不错，我们去公园吧'), 'zh'))
test('粤语', () => assert.equal(detectLanguage('我哋今日唔去啦，佢话冇时间'), 'yue'))
test('日语', () => assert.equal(detectLanguage('これはテストです'), 'ja'))
test('韩语', () => assert.equal(detectLanguage('안녕하세요 반갑습니다'), 'ko'))
test('英语', () => assert.equal(detectLanguage('Let us go to the park'), 'en'))
test('空串与纯数字', () => {
  assert.equal(detectLanguage(''), 'unknown')
  assert.equal(detectLanguage('123 456 !!!'), 'unknown')
})
test('中英混合以汉字为主判中文', () => {
  assert.equal(detectLanguage('这个 API 的 response 有点 slow'), 'zh')
})

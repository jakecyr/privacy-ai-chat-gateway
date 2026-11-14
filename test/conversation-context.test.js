import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openAIPayload} from '../openai-payload.js';
import {claudePayload} from '../claude-adapter.js';
import {geminiPayload} from '../gemini-adapter.js';

const messages = [
  {role: 'user', text: 'My birthday is March 14.'},
  {role: 'assistant', text: 'Thanks for telling me.'},
  {role: 'user', text: 'Suggest a birthday activity.'},
  {role: 'assistant', text: 'How about a picnic?'},
  {role: 'user', text: 'When is my birthday, and what did you suggest?'}
];

test('every provider receives preceding user and assistant turns in order', () => {
  const input = {messages, memory: []};
  assert.deepEqual(openAIPayload(input).input, messages.map(message => ({role: message.role, content: message.text})));
  assert.deepEqual(claudePayload(input).messages, messages.map(message => ({role: message.role, content: [{type: 'text', text: message.text}]})));
  assert.deepEqual(geminiPayload(input).contents, messages.map(message => ({role: message.role === 'assistant' ? 'model' : 'user', parts: [{text: message.text}]})));
});

test('optional memories preserve the entire same-thread conversation', () => {
  const input = {messages, memory: ['Prefers outdoor activities']};
  const openAI = openAIPayload(input).input;
  assert.deepEqual(openAI.slice(1), messages.map(message => ({role: message.role, content: message.text})));
  const claude = claudePayload(input).messages;
  const gemini = geminiPayload(input).contents;
  assert.equal(claude[0].content.at(-1).text, messages[0].text);
  assert.equal(gemini[0].parts.at(-1).text, messages[0].text);
  assert.deepEqual(claude.slice(1), messages.slice(1).map(message => ({role: message.role, content: [{type: 'text', text: message.text}]})));
  assert.deepEqual(gemini.slice(1), messages.slice(1).map(message => ({role: message.role === 'assistant' ? 'model' : 'user', parts: [{text: message.text}]})));
});

// src/emitter.js
export function emitter() {
  const handlers = {};
  return {
    on: (event, fn) => (handlers[event] ||= []).push(fn),
    emit: (event, value) => (handlers[event] || []).forEach(fn => fn(value))
  };
}

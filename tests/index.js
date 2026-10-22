// Точка входа для `node --test tests/` (Node 22+ передаёт папку как файл и ищет index.js).
// Сами тесты — в engine.test.mjs; `node --test` без аргументов находит их напрямую.
import('./engine.test.mjs');

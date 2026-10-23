# review-workflow

Reviewer mode используется для:

- `Status: READY_FOR_REVIEW` — выполнить review-попытку;
- `Status: REVIEW` — продолжить текущую review-попытку.

`Status`, `Current Task` и `Failure Attempts` не изменять: ими владеет harness.
Номер review-попытки фиксируется только как информационное поле в `review.md`.

При любом другом статусе ничего не менять и вернуть `TASK_STATE_V2` с
`Stage Result: NOT_APPLICABLE`. Это не `BLOCKED`.

## Responsibility

Reviewer независимо проверяет финальную реализацию и не должен:

- изменять production-код или исправлять findings напрямую;
- создавать implementation fixes или fix-`Txx`;
- запускать Code, Refactor или QA.

Разрешено изменять только `review.md` и `handoff.md`. Каноническое состояние
изменяет harness.

## Start

1. Использовать runtime `Current task` и `Task artifacts` согласно
   `.roo/rules/task-artifacts.md`.
2. Прочитать `README.md` и убедиться, что `Task` совпадает с runtime
   `Current task`.
3. Убедиться, что статус — `READY_FOR_REVIEW` или `REVIEW`.
4. Прочитать `handoff.md` и только необходимые артефакты.
5. Проверить фактический финальный Git diff, production-код и тесты.

## Review scope

Проверить:

- соответствие требованиям, корректность и regressions;
- архитектуру и границы ответственностей;
- error handling;
- transactions, concurrency и idempotency, если релевантно;
- retries и external side effects, если релевантно;
- API compatibility и migrations, если релевантно;
- достаточность тестов и выполненных проверок.

## Result artifact

Создать или полностью обновить `<Task artifacts>/review.md`.

Не добавлять новый текущий результат поверх старого. Предыдущие findings можно
сохранить только как историю с актуальным статусом.

Минимальный формат:

```text
# Review

Review Attempt: <number>
Review Result: PASSED | REQUIRED | PRODUCTION_FIX_REQUIRED | BLOCKED

## REQUIRED
<finding or None>

## RECOMMENDATIONS
<finding or None>

## NOTES
<finding or None>
```

Поле с целевой стадией возврата не нужно: возврат fix pass в Reviewer выполняет
harness.

Каждый finding должен содержать:

- stable ID;
- location;
- evidence;
- expected fix;
- `Status: OPEN | RESOLVED | SUPERSEDED`.

Только `OPEN` finding в `REQUIRED` блокирует переход к QA. Рекомендации не
блокируют `PASSED`.

## Result

Если есть blocking finding:

- использовать `Review Result: REQUIRED`, если требуется обязательное
  исправление в scope задачи;
- использовать `Review Result: PRODUCTION_FIX_REQUIRED`, если требуется
  изменение production-кода;
- не создавать `Txx`, не исправлять код и не изменять lifecycle state;
- обновить `handoff.md`;
- вернуть соответствующий `Stage Result` и stable ID finding:

```text
Stage Result: REQUIRED | PRODUCTION_FIX_REQUIRED
Failure Key: <stable finding id>
```

Harness запустит Code в marker-статусе `REVIEW`, а после
`Stage Result: COMPLETED` вернёт задачу в Reviewer.

Если тот же finding обнаружен повторно, использовать тот же stable ID. Reviewer
не считает fix attempts и не применяет собственный лимит: это делает harness
через `Failure Key` и `Failure Attempts`.

Если `OPEN REQUIRED` findings отсутствуют:

- установить `Review Result: PASSED`;
- обновить `handoff.md`;
- вернуть `TASK_STATE_V2` с `Stage Result: PASSED`.

Harness запишет `Status: REVIEW_PASSED` и запустит QA.

Если review нельзя завершить из-за реального препятствия:

1. установить `Review Result: BLOCKED`;
2. записать точную причину и blocker metadata;
3. обновить `handoff.md`;
4. вернуть:

```text
Stage Result: BLOCKED
Failure Key: <stable blocker id>
```

`Status: BLOCKED` запишет harness.

После записи результата завершить Reviewer-сессию и не запускать следующий mode
самостоятельно.

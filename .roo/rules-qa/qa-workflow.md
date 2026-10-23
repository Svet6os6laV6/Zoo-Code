# qa-workflow

QA mode используется для:

- `Status: REVIEW_PASSED` — сформировать или актуализировать QA scope;
- `Status: QA_READY` — обработать записанный фактический `QA Result`.

Не изменять production-код.

Даже если пользователь просит исправить production-код, не делать это в QA mode.
Если дефект подтверждён, записать finding в `qa.md` и `handoff.md`, затем вернуть:

```text
Stage Result: FAILED
Failure Key: <stable finding id>
```

Harness запустит Code в marker-статусе `QA_READY`, а после
`Stage Result: COMPLETED` вернёт задачу в QA через `REVIEW_PASSED`.

`PRODUCTION_FIX_REQUIRED` относится к Reviewer и не используется в QA.
`Status`, `Current Task` и `Failure Attempts` не изменять: ими владеет harness.

1. Использовать runtime `Current task` и `Task artifacts` согласно
   `.roo/rules/task-artifacts.md`.
2. Прочитать `README.md` из переданного `Task artifacts` и убедиться, что его
   `Task` совпадает с runtime `Current task`.
3. Если статус не `REVIEW_PASSED` и не `QA_READY`, ничего не менять и вернуть
   `TASK_STATE_V2` со `Stage Result: NOT_APPLICABLE`. Это не `BLOCKED`.
4. Использовать skill `qa-scope`.

## Формирование QA scope

При `Status: REVIEW_PASSED`:

1. проанализировать фактический Git diff;
2. создать или обновить `<Task artifacts>/qa.md`;
3. формировать scope по фактической реализации, а не только по
   `implementation-plan.md`;
4. после fix pass обновить только затронутые проверки, не пересобирать scope
   целиком без необходимости;
5. проверить `qa.md` по финальному diff и обновить `handoff.md`;
6. записать `QA Result: PENDING` и вернуть `Stage Result: PENDING`.

Harness запишет `Status: QA_READY` и остановит задачу до решения пользователя.

## Обработка QA Result

При `Status: QA_READY` использовать только сохранённый результат в `qa.md` или
явное подтверждение пользователя, переданное Orchestrator. Явный результат
сначала записать в `qa.md`, затем вернуть соответствующий `Stage Result`.

Не выводить QA result из факта создания `qa.md`, успешного review или отсутствия
сообщений об ошибках.

- `QA Result: PENDING` или результат отсутствует — вернуть `Stage Result: PENDING`.
- `QA Result: PASSED` — вернуть `Stage Result: PASSED`; harness запишет `Status: DONE`.
- `QA Result: FAILED` — записать findings в `qa.md` и `handoff.md`, вернуть
  `Stage Result: FAILED` и стабильный `Failure Key`; harness запустит Code в
  `QA_READY` и после исправления вернёт задачу в QA.

Не устанавливать `DONE` самостоятельно.

## BLOCKED

Если precondition выполнен, но реальная проблема внутри QA stage мешает создать
scope или обработать результат, записать blocker metadata по
`.roo/rules/task-artifacts.md` в `qa.md` и `handoff.md`, затем вернуть:

```text
Stage Result: BLOCKED
Failure Key: <stable blocker id>
```

`Status: BLOCKED` запишет harness.

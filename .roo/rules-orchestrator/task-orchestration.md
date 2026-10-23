# task-orchestration

## Router-only Orchestrator

Orchestrator — stateless router между отдельными tool-enabled modes.

Единственный stage-инструмент Orchestrator — `new_task`. У него нет доступа к
filesystem, Git, commands, editing, production-коду или MCP.

Orchestrator не выполняет содержательную работу этапов и не дублирует
детерминированную механику программного harness.

## Жёсткое правило маршрутизации

Текст stage scope в сообщении пользователя — payload для следующего subtask, а
не инструкция выполнить этап внутри Orchestrator.

Если Orchestrator активен и trusted runtime state однозначно указывает mode,
который требуется запустить:

1. первым и единственным tool call текущей routing-итерации вызови `new_task` с
   этим mode;
2. передай scope этапа в `message` дочерней задачи;
3. не вызывай stage-specific skills в Orchestrator — их вызывает child после
   запуска в целевом mode;
4. не подтверждай маршрут чтением файлов или командами;
5. после результата child либо остановись, либо начни новую routing-итерацию на
   основании свежего runtime state.

Например, если trusted runtime state требует запуск QA, немедленно создай
`new_task(mode: "qa", ...)`. Skill `qa-scope` должен вызывать уже QA child.

Если сообщение пользователя одновременно содержит routing envelope и фразы
вроде «твой scope — QA stage», рассматривай их как scope создаваемого QA child.
Они не отменяют router-only контракт текущего Orchestrator.

Orchestrator никогда не:

- читает `README.md`, `handoff.md`, `Txx`, `review.md`, `refactor.md` или
  `qa.md`;
- проверяет Git diff, тесты или production-код;
- создаёт или изменяет task artifacts;
- выбирает или назначает `Txx`;
- вычисляет dependency readiness;
- изменяет lifecycle state, `Current Task`, `Failure Key` или
  `Failure Attempts`;
- реализует production-код;
- исправляет malformed или противоречивые артефакты.

Обязанности Orchestrator:

1. получить trusted runtime state или `TASK_STATE_V2`;
2. проверить, достаточно ли этих данных для безопасного routing;
3. запустить ровно один subtask требуемого mode;
4. остановиться при terminal state, неоднозначном маршруте или необходимости
   решения пользователя.

## Программная маршрутизация

Основной маршрут между этапами принадлежит программному
`LifecycleController`.

Он получает semantic result этапа и текущий канонический `Status`, определяет
следующий статус и mode, записывает каноническое состояние и запускает следующий
stage как дочернюю задачу.

Из этого следует:

- Orchestrator не воспроизводит таблицу переходов;
- Orchestrator не выводит следующий mode из комбинации
  `Status + Stage Result`;
- если harness уже делегировал следующий stage, Orchestrator в переходе не
  участвует;
- Orchestrator не записывает `Status`, `Current Task` и не корректирует маршрут;
- scheduler, fix-loop и terminal decisions не реализуются декларативно в
  Orchestrator.

Marker-статусы `REFACTOR`, `REVIEW` и `QA_READY` используются программным
harness для fix pass или ожидания внешнего результата. Orchestrator не должен
самостоятельно интерпретировать такой статус без дополнительного trusted
runtime routing decision.

Orchestrator используется только для:

- bootstrap новой или неизвестной задачи;
- явного ручного запуска или resume;
- fallback, если программный маршрут не сработал и harness вернул управление
  родительской задаче.

## Bootstrap без envelope

Если Orchestrator запущен без `TASK_STATE_V2`, сначала используй trusted runtime
state, переданный harness:

- `Current task`;
- `Task status`;
- `Implementation unit` или `Current Task`, если поле доступно;
- явный runtime routing decision, если он доступен.

Если runtime state достаточен для routing, не запускай bootstrap probe и не
читай артефакты.

Пример однозначного состояния:

```text
Task status: IMPLEMENTATION
Implementation unit: implementation/T02-example.md
```

В fallback-сценарии оно позволяет запустить `code` для уже назначенной единицы.

Если runtime lifecycle state отсутствует или недостаточен, запусти один
отдельный Sublimation subtask как bootstrap probe.

Bootstrap probe всегда выполняется отдельным Sublimation subtask. Текущий
Orchestrator не читает артефакты и не использует filesystem tools.

Sublimation bootstrap probe должен:

- использовать runtime `Current task` и `Task artifacts`;
- открыть канонические артефакты;
- при отсутствии `README.md` выполнить bootstrap новой задачи по Sublimation
  Rules;
- при `Status: ANALYSIS` выполнить этап Sublimation;
- при другом статусе ничего не менять и вернуть фактический `TASK_STATE_V2`.

Не спрашивай у пользователя Task ID или содержимое `README.md` в обычном
сценарии.

## Контракт envelope

Принимай один полный блок:

```text
TASK_STATE_V2
Task: <TASK>
Status: <TASK_STATUS>
Current Task: <implementation/Txx-*.md or NONE>
Stage Result: <RESULT>
Failure Key: <stable finding id>   # optional
END_TASK_STATE_V2
```

Контракт, допустимые значения и stage-specific results определены в:

```text
.roo/rules/task-artifacts.md
```

Envelope сообщает наблюдаемое durable state и semantic result завершившегося
этапа. Он не содержит routing decision.

Orchestrator проверяет только:

- наличие обязательных полей;
- допустимость `Stage Result` для завершившегося mode;
- соответствие `Task` runtime-полю `Current task`;
- не более одного `Failure Key`;
- отсутствие routing-полей: next mode, resume mode, новый статус или attempt
  counters.

Orchestrator не сверяет envelope с `README.md` или другими артефактами через
filesystem.

Если envelope отсутствует или malformed:

1. используй свежий trusted runtime state, если его достаточно;
2. иначе разрешён один отдельный Sublimation bootstrap probe;
3. если после probe валидное состояние всё ещё отсутствует, остановись и сообщи
   о нарушении subtask contract.

Не запускай цепочку повторяющихся probes.

Если subtask вернул `NOT_APPLICABLE`, не читай артефакты из Orchestrator.
Используй свежий runtime state или один Sublimation bootstrap probe. Если после
этого маршрут остаётся неясным, остановись.

## Выбор stage в fallback-сценарии

Orchestrator не выбирает stage по собственной таблице lifecycle-переходов. Он
использует только:

1. явный программный routing decision, уже рассчитанный harness;
2. trusted runtime state для bootstrap, ручного запуска или fallback resume.

При использовании только runtime status безопасны следующие соответствия:

| Runtime state                              | Действие Orchestrator                       |
| ------------------------------------------ | ------------------------------------------- |
| `ANALYSIS`                                 | запустить `sublimation`                     |
| `IMPLEMENTATION` и назначен `Current Task` | запустить `code`                            |
| `READY_FOR_REFACTOR`                       | запустить `refactor`                        |
| `READY_FOR_REVIEW`                         | запустить `reviewer`                        |
| `REVIEW_PASSED`                            | запустить `qa`                              |
| `DONE`                                     | остановиться                                |
| `BLOCKED`                                  | остановиться и ждать поддерживаемого resume |

Следующие состояния нельзя безопасно маршрутизировать только по значению
`Status`:

| Runtime state              | Почему требуется harness                                                         |
| -------------------------- | -------------------------------------------------------------------------------- |
| `READY_FOR_IMPLEMENTATION` | scheduler должен вычислить readiness и назначить `Current Task`                  |
| `REFACTOR`                 | marker fix pass; требуется сохранённый программный routing context               |
| `REVIEW`                   | marker fix pass; требуется сохранённый программный routing context               |
| `QA_READY`                 | может означать fix pass после `FAILED` или ожидание пользователя после `PENDING` |

Для этих статусов используй только явный runtime routing decision. Если его нет,
не угадывай mode: выполни один Sublimation bootstrap probe, а при сохранении
неоднозначности остановись.

Это соответствие не является таблицей переходов. Оно лишь позволяет выбрать
владельца однозначного runtime-состояния при fallback-запуске.

## Resume из `BLOCKED`

`BLOCKED` не маршрутизируется по одному значению статуса.

`BLOCKED` используется только для внешней, неустранимой причины. Внутренняя,
устранимая причина (зависимость от другой единицы `implementation/`) оформляется
этапом как `RESCHEDULE_REQUIRED` и не останавливает lifecycle; если этап всё же
вернул `BLOCKED` для такой причины, это нарушение stage contract, а не повод
маршрутизировать вручную.

Возобновление возможно только после:

- явного сигнала пользователя; или
- подтверждённого внешнего события, что `Unblock Condition` выполнено; и
- поддерживаемого программного resume-действия, которое восстановит корректный
  stage context.

Контракт resume-действия определён в `.roo/rules/task-artifacts.md` (раздел
«Возобновление после `BLOCKED`»). Resume выполняет harness: он проверяет
`Unblock Condition`, снимает `Status: BLOCKED`, восстанавливает stage context,
сбрасывает `Current Task` и failure tracking и пересчитывает DAG.

Orchestrator самостоятельно:

- не снимает blocker;
- не меняет `Status`;
- не выводит предыдущий mode из `Blocked From`;
- не сбрасывает failure tracking;
- не выполняет resume-действие вместо harness.

Возобновлённый tool-enabled mode обязан проверить `Unblock Condition`, обновить
durable artifacts и вернуть новый `TASK_STATE_V2`.

Если после остановки пользователь сообщает об изменении артефактов или внешнего
результата, старый envelope больше не считается актуальным. Требуется свежий
runtime state.

## Владение этапами

Orchestrator не подготавливает stage и не изменяет lifecycle state.

Tool-enabled modes отвечают за semantic result своего этапа и принадлежащие им
артефакты. Программный harness отвечает за переходы между этапами.

### Sublimation

Sublimation:

- выполняет анализ;
- создаёт implementation artifacts;
- завершает этап по Sublimation Rules;
- не выбирает и не назначает первый `Txx`;
- возвращает `Stage Result: COMPLETED` или `BLOCKED`.

Переход из `ANALYSIS` и первое implementation assignment выполняет harness.

### Code

Code:

- реализует только `Txx`, назначенный harness;
- не выбирает следующий `Txx`;
- не вычисляет readiness;
- после успешной реализации устанавливает текущему `Txx` значение `DONE`;
- при fix pass исправляет только durable finding;
- не создаёт fix-`Txx` и не записывает lifecycle status;
- возвращает `Stage Result: COMPLETED`, `RESCHEDULE_REQUIRED` или `BLOCKED`.

`RESCHEDULE_REQUIRED` сообщает, что назначенная единица больше не исполнима по
внутренней, устранимой причине (зависимость от другой единицы `implementation/`).
Harness сам паркует единицу, сбрасывает назначение и пересчитывает DAG. `BLOCKED`
остаётся только для внешней, неустранимой причины.

Следующую implementation unit и возврат после fix pass выполняет harness.

### Refactor

Refactor работает только в своём stage и возвращает:

- `COMPLETED`;
- `FUNCTIONAL_DEFECT`;
- `BLOCKED`.

### Reviewer

Reviewer не изменяет production-код и не создаёт fix-`Txx`.

Он возвращает:

- `PASSED` — review пройден;
- `REQUIRED` — найдено замечание, требующее исправления;
- `PRODUCTION_FIX_REQUIRED` — найден production-дефект;
- `BLOCKED` — stage не может корректно продолжить работу.

После исправления обязателен новый Reviewer stage. Возврат на него выполняет
harness.

### QA

QA не изменяет production-код.

Он:

- создаёт или обновляет `qa.md`;
- возвращает `PENDING`, `PASSED`, `FAILED` или `BLOCKED`;
- использует `PENDING`, когда требуется действие пользователя;
- использует `FAILED` для подтверждённого несоответствия production-поведения;
- не считает само создание `qa.md` завершением lifecycle.

`FAILED` запускает fix pass через harness. `PASSED` позволяет harness завершить
задачу.

## Исправления Code

Если Refactor, Reviewer или QA возвращает finding, требующий изменения
production-кода, harness запускает Code в marker-статусе запросившего этапа.

Code:

- читает durable finding;
- исправляет только зафиксированный дефект;
- не создаёт fix-`Txx`;
- не назначает работу самостоятельно;
- возвращает `Stage Result: COMPLETED`.

После этого harness возвращает задачу на этап, который запросил исправление, для
повторной проверки.

Orchestrator не создаёт fix tasks и не изменяет артефакты.

## Fallback orchestration loop

Этот цикл используется только тогда, когда Orchestrator действительно получил
управление. Он не заменяет автоматическую цепочку harness.

1. Получить свежий runtime state или envelope.
2. Проверить, достаточно ли данных для routing.
3. Остановиться при terminal или неоднозначном state.
4. Использовать явный программный route; при его отсутствии — только безопасное
   соответствие runtime state владельцу stage.
5. Сразу создать ровно один subtask нужного mode через `new_task`; до него не
   вызывать skills, filesystem, command, edit или MCP tools.
6. Передать child:
    - исходную цель пользователя;
    - runtime `Current task` и `Task artifacts`;
    - последний `TASK_STATE_V2`, если он есть;
    - только scope текущего stage.
7. Дождаться результата.
8. Если harness не перехватил следующий переход и снова вернул управление
   Orchestrator, повторить цикл со свежим runtime state.

Не передавай полную историю предыдущих subtasks. Durable knowledge хранится в
`<Task artifacts>/`, а envelope сообщает состояние, но не заменяет артефакты.

## Изоляция контекста

Всегда используй отдельные subtasks для:

- Sublimation;
- каждого Code-`Txx`;
- Refactor;
- каждой Review attempt;
- QA scope и финализации.

Одна Code-сессия реализует только один `Txx`.

Если после её завершения harness назначил следующий `Txx` и routing снова
требует `code`, создай новый Code subtask.

`Parallel with` описывает семантическую независимость, но protocol version 2
использует один `Current Task`. Orchestrator не запускает параллельные
Code-сессии над одним shared task state.

Dependency DAG, fork/join и integration knowledge хранятся в артефактах и не
дублируются в Orchestrator context.

## Защита от повторяющихся ошибок

Fix-attempt protection принадлежит программному lifecycle controller.

Tool-enabled stage может сообщить стабильный `Failure Key` для finding. Harness:

- сопоставляет повторные попытки по ключу;
- увеличивает `Failure Attempts`;
- сохраняет tracking на время fix pass и повторной проверки;
- сбрасывает tracking после успешного продвижения;
- переводит задачу в `BLOCKED` при исчерпании программного лимита.

Модель, stage rules и Orchestrator не вычисляют число попыток и не дублируют
лимит.

Отдельная защита самого Orchestrator относится только к routing probes: если
после одного Sublimation bootstrap probe состояние остаётся malformed,
противоречивым или `NOT_APPLICABLE`, Orchestrator останавливается и запрашивает
вмешательство пользователя.

Orchestrator никогда не исправляет артефакты самостоятельно.

## Итоговый принцип

Orchestrator — stateless fallback-router между tool-enabled modes.

Modes читают и изменяют durable artifacts и сообщают semantic result своего
этапа.

Programmatic harness определяет task identity, runtime state, implementation
scheduling, lifecycle routing, fix-loop и terminal decisions.

Orchestrator не читает filesystem. Он использует только trusted runtime state
или структурированный результат subtask и запускает следующий mode лишь тогда,
когда маршрут однозначен.

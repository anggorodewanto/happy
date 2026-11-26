package com.slopus.happy.chat

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonElement

// Background work a Claude Code session started besides its own turn: commands
// started with run_in_background, background subagents and watchers. Two
// sources feed it, in this order:
//
// - Live SDK events: happy-cli forwards the Agent SDK's `task_started`,
//   `task_progress`, `task_updated` and `task_notification` system messages as
//   the additive `task` session event (sessionProtocolMapper.ts). They carry
//   the exact task id and tool-use id, progress and counters, and the final
//   status. When they exist they win.
// - What an older CLI sends: the tool call that started a task (its
//   `run_in_background` input, with the command and description) and the
//   `<task-notification>` envelope Claude Code writes into the conversation when
//   the task ends (happy-wire controlMessages.ts). That is the fallback, with
//   no live progress.
//
// A task still running when its session's CLI is gone is shown ended with the
// session (see ChatState.backgroundTasks).

private const val TASK_NOTIFICATION_OPEN = "<task-notification>"
private const val TASK_NOTIFICATION_CLOSE = "</task-notification>"

/** How a background task was started, for its glyph and its words. */
enum class BackgroundTaskKind { Command, Subagent, Other }

/** Where a background task stands. [Running] is `Running` until a notification says otherwise. */
enum class BackgroundTaskStatus {
    Running, Completed, Failed, Cancelled;

    companion object {
        /** A notification's `<status>` (Claude Code: completed, failed, killed, stopped…). */
        fun of(raw: String?): BackgroundTaskStatus {
            return when (raw?.trim()?.lowercase()) {
                null, "" -> Completed
                "failed", "error", "errored" -> Failed
                "cancelled", "canceled", "stopped", "aborted", "killed", "interrupted" -> Cancelled
                else -> Completed
            }
        }
    }
}

/** Which SDK system message a live [BackgroundTaskEvent] came from. */
enum class BackgroundTaskPhase {
    Started, Progress, Updated, Notification;

    companion object {
        fun of(raw: String?): BackgroundTaskPhase? = when (raw?.trim()?.lowercase()) {
            "started" -> Started
            "progress" -> Progress
            "updated" -> Updated
            "notification" -> Notification
            else -> null
        }
    }
}

/**
 * One live background-task event from the Claude Agent SDK's `task_started`,
 * `task_progress`, `task_updated` and `task_notification` system messages,
 * forwarded by happy-cli as the `task` session event. Unlike
 * [BackgroundTaskNotification], which Claude Code writes into the conversation
 * when a task ends, these arrive while it runs.
 */
@Immutable
data class BackgroundTaskEvent(
    val phase: BackgroundTaskPhase,
    val taskId: String,
    val toolUseId: String? = null,
    val description: String? = null,
    val status: String? = null,
    val summary: String? = null,
    val lastToolName: String? = null,
    val outputFile: String? = null,
    val taskType: String? = null,
    val isBackgrounded: Boolean? = null,
    val totalTokens: Long? = null,
    val toolUses: Long? = null,
    val durationMs: Long? = null,
)

/**
 * One background task of a session, as far as the protocol carries it. A task
 * started with `run_in_background` has its command and description from the
 * tool call; its id, status and summary come from the notification that ends
 * it, matched by the tool use id the notification names, else by the quoted
 * description in its summary. A task only ever seen by its notification (a
 * session opened after it started) has no [startedAt] and no [command].
 */
@Immutable
data class BackgroundTask(
    /** Stable key for the list: the tool call's `call:<id>`, else the notification's `task:<id>`. */
    val id: String,
    val kind: BackgroundTaskKind,
    val title: String,
    /** The Bash command, when the task is a background command. */
    val command: String? = null,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val status: BackgroundTaskStatus = BackgroundTaskStatus.Running,
    /** The notification's `<summary>`: how it ended, or what the notification knew. */
    val summary: String? = null,
    /** The notification's `<output-file>`, where a background command's output was written. */
    val outputFile: String? = null,
    val subagentTokens: Long? = null,
    val toolUses: Long? = null,
    /** The notification's `<task-id>`, once one has named this task. */
    val taskId: String? = null,
    /** The SDK's live progress line (`task_progress.summary`), while it runs. */
    val progress: String? = null,
    /** The last tool a running task used, and its live counters. */
    val lastToolName: String? = null,
    val totalTokens: Long? = null,
    val durationMs: Long? = null,
    /** True once a live SDK event has described this task. */
    val hasLiveUpdates: Boolean = false,
    /** Running when its session's CLI went away: listed as ended, never as running. */
    val endedWithSession: Boolean = false,
) {
    val isRunning: Boolean get() = status == BackgroundTaskStatus.Running
}

/**
 * The tasks a CLI session still runs: every running one ends with the
 * session when its CLI is gone ([cliGone]), and so does one started before
 * the CLI process that runs the session now ([cliStartedAt]).
 */
fun liveBackgroundTasks(tasks: List<BackgroundTask>, cliGone: Boolean, cliStartedAt: Long?): List<BackgroundTask> {
    if (cliGone) return tasks.map { it.endedWithSession() }
    if (cliStartedAt == null) return tasks
    return tasks.map { task -> if (task.startedBefore(cliStartedAt)) task.endedWithSession() else task }
}

/** True when the task's start is known and came before [instant]. */
fun BackgroundTask.startedBefore(instant: Long): Boolean {
    val started = startedAt ?: return false
    return started < instant
}

/** A task still running when its session's CLI is gone reads as ended, without a made-up end time. */
fun BackgroundTask.endedWithSession(): BackgroundTask {
    if (!isRunning) return this
    return copy(
        status = BackgroundTaskStatus.Cancelled,
        endedWithSession = true,
        progress = null,
        lastToolName = null,
        durationMs = null,
    )
}

/**
 * A `<task-notification>` envelope: what Claude Code writes into the
 * conversation when a background task ends (happy-wire controlMessages.ts).
 * The fields are optional because the producer writes fewer of them for some
 * kinds (a command has no `<result>`, a subagent has no `<output-file>`).
 * Field values are XML-escaped in the envelope (a command's `2>/dev/null`
 * arrives as `2&gt;/dev/null`) and are kept decoded.
 */
@Immutable
data class BackgroundTaskNotification(
    val taskId: String? = null,
    /** The `<tool-use-id>` of the call that started the task; the CLI sends it for every kind. */
    val toolUseId: String? = null,
    val rawStatus: String? = null,
    val summary: String? = null,
    val result: String? = null,
    val outputFile: String? = null,
    val subagentTokens: Long? = null,
    val toolUses: Long? = null,
) {
    val status: BackgroundTaskStatus get() = BackgroundTaskStatus.of(rawStatus)

    /** The name the summary quotes: `Background command "npm run build" completed (exit code 0)`. */
    val quotedTitle: String?
        get() = summary?.let { QUOTED.find(it) }?.groupValues?.getOrNull(1)?.trim()?.takeIf { it.isNotEmpty() }

    companion object {
        private val TAGS = listOf(
            "task-id", "tool-use-id", "status", "summary", "result", "output-file", "subagent_tokens", "tool_uses",
        )

        /** One envelope's body (the tags between `<task-notification>` and its close). */
        fun parse(body: String): BackgroundTaskNotification? {
            val fields = TAGS.associateWith { tag -> text(body, tag)?.let(::decode) }
            val notification = BackgroundTaskNotification(
                taskId = fields["task-id"],
                toolUseId = fields["tool-use-id"],
                rawStatus = fields["status"],
                summary = fields["summary"],
                result = fields["result"],
                outputFile = fields["output-file"],
                subagentTokens = fields["subagent_tokens"]?.toLongOrNull(),
                toolUses = fields["tool_uses"]?.toLongOrNull(),
            )
            // An empty wrapper says nothing; leaving it out keeps a stray
            // `<task-notification></task-notification>` from closing a task.
            if (notification.taskId == null && notification.summary == null && notification.rawStatus == null) return null
            return notification
        }

        private fun text(body: String, tag: String): String? {
            val match = Regex("<$tag>(.*?)</$tag>", RegexOption.DOT_MATCHES_ALL).find(body) ?: return null
            return match.groupValues[1].trim().takeIf { it.isNotEmpty() }
        }

        /** The XML entities Claude Code escapes field values with; `&amp;` last, so none is decoded twice. */
        private fun decode(text: String): String = text
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&apos;", "'")
            .replace("&amp;", "&")
    }
}

private val QUOTED = Regex("\"([^\"]+)\"")

/**
 * The complete leading `<task-notification>` envelopes of [text] and what is
 * left of it (happy-wire controlMessages.ts). Incomplete wrappers and tags
 * written inline by a person are left where they are.
 */
fun takeLeadingTaskNotifications(text: String): Pair<List<BackgroundTaskNotification>, String> {
    var remainder = text.trimStart()
    val notifications = ArrayList<BackgroundTaskNotification>()
    var stripped = false
    while (remainder.startsWith(TASK_NOTIFICATION_OPEN)) {
        val end = leadingTaskNotificationEnd(remainder) ?: break
        val body = remainder.substring(TASK_NOTIFICATION_OPEN.length, end - TASK_NOTIFICATION_CLOSE.length)
        BackgroundTaskNotification.parse(body)?.let(notifications::add)
        stripped = true
        remainder = remainder.substring(end).trimStart()
    }
    return notifications to if (stripped) remainder else text
}

/** The offset just past the first leading wrapper's closing tag, or null if it never closes. */
private fun leadingTaskNotificationEnd(text: String): Int? {
    var depth = 1
    var cursor = TASK_NOTIFICATION_OPEN.length
    while (depth > 0) {
        val nextOpen = text.indexOf(TASK_NOTIFICATION_OPEN, cursor)
        val nextClose = text.indexOf(TASK_NOTIFICATION_CLOSE, cursor)
        if (nextClose == -1) return null
        if (nextOpen != -1 && nextOpen < nextClose) {
            depth += 1
            cursor = nextOpen + TASK_NOTIFICATION_OPEN.length
        } else {
            depth -= 1
            cursor = nextClose + TASK_NOTIFICATION_CLOSE.length
        }
    }
    return cursor
}

/**
 * The tasks of one session, kept as the reducer folds its records: a tool call
 * that asked to run in the background starts one, a task notification ends it.
 * A notification is joined to its call by the tool use id it names (the CLI's
 * `tool-call-end` carries no result text, so its task id is never learned from
 * the result); failing that, by the description its summary quotes; and when
 * nothing quotes it and one task alone is still running, that one is taken as
 * its end. Feed records in order ([start] before [notify] for the same record
 * batch).
 */
internal class BackgroundTaskTracker {
    private val tasks = LinkedHashMap<String, BackgroundTask>()
    /** Live task ids the SDK started in the foreground; their later events draw no row. */
    private val foregroundTaskIds = HashSet<String>()
    /** Notification task ids already applied, so a repeated envelope updates nothing twice. */
    private val keyByTaskId = HashMap<String, String>()
    private val pendingStops = HashMap<String, Long>()
    /** Notifications without a task id, by their content, so a repeat adds no second row. */
    private val anonymous = HashSet<String>()
    private var nextAnonymous = 0L

    val snapshot: List<BackgroundTask> get() = tasks.values.toList()

    fun start(callId: String, name: String, input: JsonElement?, at: Long) {
        val args = input.obj ?: return
        val normalizedName = name.trim().lowercase()
        // Claude Code sends no <task-notification> for a task it stops, so the
        // stop call itself ends the task it names.
        if (normalizedName in STOP_TOOLS) {
            val stoppedId = (args["task_id"].str ?: args["shell_id"].str)?.trim()?.takeIf { it.isNotEmpty() } ?: return
            stop(stoppedId, at)
            return
        }
        // Monitor tool always runs in background, no flag needed
        val isMonitor = normalizedName == "monitor"
        val runsInBackground = args["run_in_background"].bool == true || isMonitor
        if (!runsInBackground) return
        val key = "call:$callId"
        if (key in tasks) return
        val command = args["command"].str?.trim()?.takeIf { it.isNotEmpty() }
        val description = args["description"].str?.trim()?.takeIf { it.isNotEmpty() }
        val prompt = args["prompt"].str?.trim()?.takeIf { it.isNotEmpty() }
        val title = description ?: prompt ?: command?.substringBefore('\n')?.trim()?.take(TITLE_LIMIT) ?: name
        tasks[key] = BackgroundTask(id = key, kind = kindOf(name), title = title, command = command, startedAt = at)
    }

    /** Ends the running task Claude Code knows as [taskId], if it is one we track. */
    fun stop(taskId: String, at: Long) {
        // A history replay reduces every tool call before any result, so the
        // stop can come before the result that names its task: hold it.
        val key = keyByTaskId[taskId] ?: run { pendingStops[taskId] = at; return }
        val task = tasks[key] ?: return
        if (!task.isRunning) return
        tasks[key] = task.copy(status = BackgroundTaskStatus.Cancelled, finishedAt = at)
    }

    fun result(callId: String, resultText: String?) {
        val key = "call:$callId"
        if (key !in tasks) return
        if (resultText == null) return
        // Extract task ID from Claude Code's result text:
        // - Bash: "Command running in background with ID: b6h0hc9m1."
        // - Agent: "agentId: a5a83112e6d5e344f"
        // - Monitor: "Monitor started (task b6rr103fb, timeout 1800000ms)."
        val bashMatch = BASH_TASK_ID.find(resultText)
        val agentMatch = AGENT_ID.find(resultText)
        val monitorMatch = MONITOR_TASK_ID.find(resultText)
        val taskId = bashMatch?.groupValues?.get(1)
            ?: monitorMatch?.groupValues?.get(1)
            ?: agentMatch?.groupValues?.get(1)
        if (taskId != null) {
            // A live `started` without a tool-use id may have made its own
            // `task:<id>` row before this result named the call: fold it in.
            val liveKey = "task:$taskId"
            if (keyByTaskId[taskId] == liveKey && liveKey in tasks) {
                merge(liveKey, key)
            }
            keyByTaskId[taskId] = key
            tasks[key] = tasks.getValue(key).copy(taskId = taskId)
            pendingStops.remove(taskId)?.let { stoppedAt -> stop(taskId, stoppedAt) }
        }
        // Extract output file for Bash commands
        val outputFileMatch = OUTPUT_FILE.find(resultText)
        val outputFile = outputFileMatch?.groupValues?.get(1)
        if (outputFile != null) {
            tasks[key] = tasks.getValue(key).copy(outputFile = outputFile)
        }
    }

    fun live(event: BackgroundTaskEvent, at: Long) {
        when (event.phase) {
            BackgroundTaskPhase.Started -> liveStarted(event, at)
            BackgroundTaskPhase.Progress -> liveProgress(event, at)
            BackgroundTaskPhase.Updated -> liveUpdated(event, at)
            BackgroundTaskPhase.Notification -> liveNotification(event, at)
        }
    }

    private fun liveStarted(event: BackgroundTaskEvent, at: Long) {
        // The SDK reports every Bash call and subagent as a task; one that runs
        // in the foreground is not a background task unless a background call
        // already started its row.
        if (event.isBackgrounded == false && keyOf(event) == null) {
            foregroundTaskIds.add(event.taskId)
            return
        }
        val key = link(event, at) ?: return
        val task = tasks.getValue(key)
        val description = event.description?.trim()?.takeIf { it.isNotEmpty() }
        tasks[key] = task.copy(
            taskId = event.taskId,
            title = betterTitle(task, description),
            kind = if (task.kind == BackgroundTaskKind.Other) kindOfLive(event) else task.kind,
            startedAt = task.startedAt ?: at,
            hasLiveUpdates = true,
        )
        pendingStops.remove(event.taskId)?.let { stoppedAt -> stop(event.taskId, stoppedAt) }
    }

    private fun liveProgress(event: BackgroundTaskEvent, at: Long) {
        val key = keyOf(event) ?: return
        val task = tasks[key] ?: return
        tasks[key] = task.copy(
            hasLiveUpdates = true,
            progress = event.summary?.trim()?.takeIf { it.isNotEmpty() } ?: task.progress,
            lastToolName = event.lastToolName?.trim()?.takeIf { it.isNotEmpty() } ?: task.lastToolName,
            totalTokens = event.totalTokens ?: task.totalTokens,
            toolUses = event.toolUses ?: task.toolUses,
            durationMs = event.durationMs ?: task.durationMs,
        )
    }

    private fun liveUpdated(event: BackgroundTaskEvent, at: Long) {
        val key = link(event, at) ?: return
        val task = tasks.getValue(key)
        val status = event.status?.let(::liveStatus) ?: BackgroundTaskStatus.Running
        val terminal = status != BackgroundTaskStatus.Running
        tasks[key] = task.copy(
            taskId = event.taskId,
            title = betterTitle(task, event.description?.trim()?.takeIf { it.isNotEmpty() }),
            status = if (terminal || task.isRunning) status else task.status,
            finishedAt = if (terminal) task.finishedAt ?: at else task.finishedAt,
            hasLiveUpdates = true,
        )
    }

    private fun liveNotification(event: BackgroundTaskEvent, at: Long) {
        val key = link(event, at) ?: return
        val task = tasks.getValue(key)
        tasks[key] = task.copy(
            taskId = event.taskId,
            status = event.status?.let(BackgroundTaskStatus::of) ?: BackgroundTaskStatus.Completed,
            finishedAt = task.finishedAt ?: at,
            summary = event.summary?.trim()?.takeIf { it.isNotEmpty() } ?: task.summary,
            outputFile = event.outputFile ?: task.outputFile,
            totalTokens = event.totalTokens ?: task.totalTokens,
            toolUses = event.toolUses ?: task.toolUses,
            durationMs = event.durationMs ?: task.durationMs,
            hasLiveUpdates = true,
        )
        keyByTaskId[event.taskId] = key
    }

    /** Fold the live row [fromKey] into the call's task [intoKey], keeping both sides' data. */
    private fun merge(fromKey: String, intoKey: String) {
        val from = tasks[fromKey] ?: return
        val into = tasks[intoKey] ?: return
        tasks[intoKey] = into.copy(
            title = into.title.takeIf { it.isNotBlank() && it != into.taskId } ?: from.title,
            taskId = into.taskId ?: from.taskId,
            startedAt = into.startedAt ?: from.startedAt,
            finishedAt = into.finishedAt ?: from.finishedAt,
            status = if (!into.isRunning) into.status else from.status,
            progress = into.progress ?: from.progress,
            lastToolName = into.lastToolName ?: from.lastToolName,
            totalTokens = into.totalTokens ?: from.totalTokens,
            toolUses = into.toolUses ?: from.toolUses,
            durationMs = into.durationMs ?: from.durationMs,
            summary = into.summary ?: from.summary,
            outputFile = into.outputFile ?: from.outputFile,
            hasLiveUpdates = into.hasLiveUpdates || from.hasLiveUpdates,
        )
        tasks.remove(fromKey)
    }

    /** The key of the task [event] names by task id or tool-use id, or null when it is not tracked. */
    private fun keyOf(event: BackgroundTaskEvent): String? {
        keyByTaskId[event.taskId]?.let { if (it in tasks) return it }
        val toolUseId = event.toolUseId ?: return null
        val callKey = "call:$toolUseId"
        return callKey.takeIf { it in tasks } ?: "task:${event.taskId}".takeIf { it in tasks }
    }

    /**
     * The task this event names, creating one when the event arrives without a
     * known start (an ended task in a session opened after it began). Progress
     * never creates a task: it carries no title or start.
     */
    private fun link(event: BackgroundTaskEvent, at: Long): String? {
        if (event.isBackgrounded == true) foregroundTaskIds.remove(event.taskId)
        if (event.taskId in foregroundTaskIds) return null
        keyOf(event)?.let { key ->
            if (tasks.getValue(key).taskId == null) tasks[key] = tasks.getValue(key).copy(taskId = event.taskId)
            keyByTaskId[event.taskId] = key
            return key
        }
        if (event.phase == BackgroundTaskPhase.Progress) return null
        val key = "task:${event.taskId}"
        if (key !in tasks) {
            val description = event.description?.trim()?.takeIf { it.isNotEmpty() }
            tasks[key] = BackgroundTask(
                id = key,
                kind = kindOfLive(event),
                title = description ?: event.taskId,
                startedAt = if (event.phase == BackgroundTaskPhase.Started) at else null,
                taskId = event.taskId,
                hasLiveUpdates = true,
            )
        }
        keyByTaskId[event.taskId] = key
        return key
    }

    /** Keep the call's own title; replace a placeholder (the task id) with the event's description. */
    private fun betterTitle(task: BackgroundTask, description: String?): String {
        if (description == null) return task.title
        if (task.title.isBlank() || task.title == task.taskId) return description
        return task.title
    }

    private fun kindOfLive(event: BackgroundTaskEvent): BackgroundTaskKind {
        val type = event.taskType?.trim()?.lowercase()
        if (!type.isNullOrEmpty()) {
            return when {
                type.contains("agent") || type.contains("subagent") -> BackgroundTaskKind.Subagent
                type.contains("command") || type.contains("bash") || type.contains("shell") -> BackgroundTaskKind.Command
                else -> BackgroundTaskKind.Other
            }
        }
        return kindOfSummary(event.description)
    }

    private fun liveStatus(raw: String): BackgroundTaskStatus = when (raw.trim().lowercase()) {
        "running", "pending", "paused" -> BackgroundTaskStatus.Running
        "failed", "error", "errored" -> BackgroundTaskStatus.Failed
        "killed", "stopped", "cancelled", "canceled", "aborted", "interrupted" -> BackgroundTaskStatus.Cancelled
        else -> BackgroundTaskStatus.Completed
    }

    fun notify(notification: BackgroundTaskNotification, at: Long) {
        val taskId = notification.taskId
        if (taskId != null) {
            val known = keyByTaskId[taskId]
            if (known != null) {
                end(known, notification, at)
                return
            }
        }
        // The call that started the task names it exactly, even when no result
        // carried Claude Code's task id and another task has the same command.
        // A task already in the map, ended or not, is the one this ends: a
        // repeat never adds a second row.
        val callKey = notification.toolUseId?.let { "call:$it" }
        if (callKey != null && callKey in tasks) {
            end(callKey, notification, at)
            if (taskId != null) keyByTaskId[taskId] = callKey
            return
        }
        if (taskId == null) {
            val fingerprint = "${notification.rawStatus}|${notification.summary}|${notification.result}"
            if (!anonymous.add(fingerprint)) return
        }
        val running = tasks.values.filter { it.isRunning }
        val key = running.firstOrNull { it.matches(notification) }?.id
            ?: running.filter { it.hasLiveUpdates }.singleOrNull()?.id
            ?: running.singleOrNull()?.id
        if (key == null) {
            val created = fromNotification(notification, at)
            tasks[created.id] = created
            if (taskId != null) keyByTaskId[taskId] = created.id
            return
        }
        tasks[key] = tasks.getValue(key).ended(notification, at)
        if (taskId != null) keyByTaskId[taskId] = key
    }

    /** Ends the task at [key] with [notification]; one that already finished keeps how it ended. */
    private fun end(key: String, notification: BackgroundTaskNotification, at: Long) {
        val task = tasks[key] ?: return
        if (!task.isRunning) return
        tasks[key] = task.ended(notification, at)
    }

    private fun fromNotification(notification: BackgroundTaskNotification, at: Long): BackgroundTask {
        val key = notification.taskId?.let { "task:$it" } ?: "task:anonymous-${nextAnonymous++}"
        val summary = notification.summary
        return BackgroundTask(
            id = key,
            kind = kindOfSummary(summary),
            title = notification.quotedTitle ?: summary ?: notification.taskId.orEmpty(),
            finishedAt = at,
            status = notification.status,
            summary = summary?.takeIf { it != notification.quotedTitle },
            outputFile = notification.outputFile,
            subagentTokens = notification.subagentTokens,
            toolUses = notification.toolUses,
            taskId = notification.taskId,
        )
    }

    private fun BackgroundTask.matches(notification: BackgroundTaskNotification): Boolean {
        val quoted = notification.quotedTitle ?: return false
        if (sameText(title, quoted)) return true
        return command != null && sameText(command, quoted)
    }

    private fun BackgroundTask.ended(notification: BackgroundTaskNotification, at: Long): BackgroundTask = copy(
        status = notification.status,
        finishedAt = at,
        summary = notification.summary,
        outputFile = notification.outputFile ?: outputFile,
        subagentTokens = notification.subagentTokens ?: subagentTokens,
        toolUses = notification.toolUses ?: toolUses,
        taskId = notification.taskId ?: taskId,
    )

    companion object {
        private const val TITLE_LIMIT = 80

        // Regexes to extract task IDs from Claude Code's tool result text.
        // Bash: "Command running in background with ID: b6h0hc9m1."
        /** Claude Code's tools that stop a background task by id (TaskStop; KillShell/KillBash before it). */
        private val STOP_TOOLS = setOf("taskstop", "killshell", "killbash")
        private val BASH_TASK_ID = Regex("""Command running in background with ID:\s*([a-z0-9]+)\.""")
        // Agent: "agentId: a5a83112e6d5e344f"
        private val AGENT_ID = Regex("""agentId:\s*([a-z0-9]+)""")
        // Monitor: "Monitor started (task b6rr103fb, timeout 1800000ms)."
        private val MONITOR_TASK_ID = Regex("""Monitor started \(task\s+([a-z0-9]+),""")
        // Output file: "Output is being written to: /path/to/file"
        private val OUTPUT_FILE = Regex("""Output is being written to:\s*(\S+?)\.?(?=\s|$)""")

        private fun kindOf(tool: String): BackgroundTaskKind {
            return when (tool.trim().lowercase()) {
                "bash", "shell", "command", "run_command", "execute" -> BackgroundTaskKind.Command
                "task", "agent" -> BackgroundTaskKind.Subagent
                "monitor" -> BackgroundTaskKind.Other
                else -> BackgroundTaskKind.Other
            }
        }

        private fun kindOfSummary(summary: String?): BackgroundTaskKind {
            val text = summary?.trim()?.lowercase() ?: return BackgroundTaskKind.Other
            return when {
                text.startsWith("background command") || text.startsWith("command ") -> BackgroundTaskKind.Command
                text.startsWith("agent") || text.startsWith("subagent") || text.startsWith("background agent") -> BackgroundTaskKind.Subagent
                else -> BackgroundTaskKind.Other
            }
        }

        /**
         * The CLI cuts a tool title at 77 characters with "..."; either side may
         * be the cut one, so a long prefix counts as the same text.
         */
        private fun sameText(a: String, b: String): Boolean {
            val left = normalize(a)
            val right = normalize(b)
            if (left.isEmpty() || right.isEmpty()) return false
            if (left == right) return true
            val (shorter, longer) = if (left.length <= right.length) left to right else right to left
            return shorter.length >= 24 && longer.startsWith(shorter)
        }

        private fun normalize(text: String): String {
            return text.trim().removeSuffix("...").trim().lowercase().replace(Regex("\\s+"), " ")
        }
    }
}

/**
 * What the session screen lists, in the order it lists it: running first
 * (oldest first), then the most recently finished (newest first), at most
 * [finishedLimit] of those.
 */
fun backgroundTasksForDisplay(tasks: List<BackgroundTask>, finishedLimit: Int = 10): List<BackgroundTask> {
    val running = tasks.filter { it.isRunning }.sortedBy { it.startedAt ?: Long.MAX_VALUE }
    val finished = tasks.filterNot { it.isRunning }.sortedByDescending { it.finishedAt ?: it.startedAt ?: 0 }
    return running + finished.take(finishedLimit)
}

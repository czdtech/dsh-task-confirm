window.__ModuleLoader__.load({
	id: "dsh-task-confirm",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let client_store = require("@deepseek-ai/dsh-client-store");

		/** Host Loader entry id and settings namespace. */
		const NS = "dsh-task-confirm";
		// Must match STATUS_ROUTE / CANCEL_ROUTE in src/index.ts.
		const STATUS_URL = "/api/task-confirm/status";
		const CANCEL_URL = "/api/task-confirm/cancel";
		// A running session means live changes: poll fast.
		const ACTIVE_REFRESH_MS = 4000;
		// Idle pages keep a slow floor so a change elsewhere still surfaces.
		const IDLE_REFRESH_MS = 60000;

		const formLabels = {
			unavailable: "该插件当前未加载，暂时无法配置。",
			readOnly: "本部署的设置为只读。",
			saveFailed: "本部署没有接受这些值，请修正后重试。",
			save: "保存",
			saving: "保存中…",
		};

		const overriddenLabel = "已覆盖";
		const resetLabel = "恢复默认";

		const styles = {
			hint: {
				color: "var(--dsw-alias-label-tertiary)",
				margin: 0,
				fontSize: "12px",
				lineHeight: 1.5,
			},
			title: {
				fontSize: "13px",
				lineHeight: 1.5,
			},
			panel: {
				display: "grid",
				gap: "8px",
				borderTop: "1px solid var(--dsw-alias-border-secondary, rgba(128, 128, 128, 0.2))",
				paddingTop: "12px",
			},
			rowBetween: {
				display: "flex",
				alignItems: "flex-start",
				justifyContent: "space-between",
				gap: "16px",
				color: "var(--dsw-alias-label-primary)",
				fontSize: "13px",
				lineHeight: 1.5,
			},
			summary: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: "12px",
				whiteSpace: "nowrap",
			},
			rows: {
				display: "grid",
				gap: "6px",
			},
			row: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "12px",
				borderRadius: "8px",
				background: "var(--dsw-alias-fill-l1, rgba(128, 128, 128, 0.08))",
				padding: "8px 10px",
			},
			rowText: {
				minWidth: 0,
				display: "grid",
				gap: "2px",
			},
			rowTitle: {
				color: "var(--dsw-alias-label-primary)",
				fontSize: "13px",
				lineHeight: 1.5,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			},
			cancelButton: {
				flex: "none",
				border: "1px solid var(--dsw-alias-border-secondary, rgba(128, 128, 128, 0.3))",
				borderRadius: "6px",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary)",
				fontSize: "12px",
				lineHeight: "18px",
				padding: "2px 10px",
				cursor: "pointer",
			},
		};

		/** Boolean form field: stages "true"/"false" through the shared Save button. */
		function booleanField(field) {
			return {
				field,
				format: (value) => (value === true ? "true" : "false"),
				parse: (text) => ({ kind: "set", value: text === "true" }),
			};
		}

		/** Minutes on screen, milliseconds in the Host config. */
		function minutesField(field) {
			return {
				field,
				format: (value) => (typeof value === "number" ? String(Math.round(value / 60000)) : ""),
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const minutes = Number(trimmed);
					if (!Number.isInteger(minutes) || minutes < 0 || minutes > 43200) return undefined;
					return { kind: "set", value: minutes * 60000 };
				},
			};
		}

		/** Comma/顿号 separated lists; an empty entry clears the list, not the default. */
		function listField(field) {
			return {
				field,
				format: (value) => (Array.isArray(value) ? value.join("、") : ""),
				parse: (text) => ({
					kind: "set",
					value: text
						.split(/[,，、\n]/)
						.map((item) => item.trim())
						.filter(Boolean),
				}),
			};
		}

		function shortSessionId(id) {
			const bare = id.startsWith("session-") ? id.slice("session-".length) : id;
			return bare.length > 8 ? bare.slice(0, 8) : bare;
		}

		function formatDuration(milliseconds) {
			const seconds = Math.max(0, Math.round(milliseconds / 1000));
			if (seconds < 60) return `${seconds} 秒`;
			const minutes = Math.round(seconds / 60);
			if (minutes < 60) return `${minutes} 分钟`;
			const hours = Math.floor(minutes / 60);
			const rest = minutes % 60;
			if (hours < 48) return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
			return `${Math.floor(hours / 24)} 天`;
		}

		function rowMeta(status, row) {
			if (row.phase === "confirmed") return "已确认，执行中";
			const parts = ["待确认"];
			if (row.awaitingSince != null && typeof status.now === "number") {
				parts.push(`已等待 ${formatDuration(status.now - row.awaitingSince)}`);
			}
			if (typeof status.pendingTtlMs !== "number" || status.pendingTtlMs <= 0 || row.awaitingSince == null) {
				parts.push("不过期");
			} else {
				const remaining = row.awaitingSince + status.pendingTtlMs - status.now;
				parts.push(remaining > 0 ? `${formatDuration(remaining)}后过期` : "已过期");
			}
			return parts.join(" · ");
		}

		/**
		 * Status refresh policy: fast while a session runs, a slow floor while idle.
		 * Events wake the loop; a hidden page stops asking until it is visible again.
		 */
		class StatusRefreshScheduler {
			constructor(options) {
				this.refresh = options.refresh;
				this.isActive = options.isActive;
				this.isVisible = options.isVisible;
				this.schedule = options.schedule;
				this.cancel = options.cancel;
				this.timer = null;
				this.stopped = false;
				this.busy = false;
				this.rerun = false;
			}

			start() {
				this.stopped = false;
				void this.run(true);
			}

			stop() {
				this.stopped = true;
				this.clearTimer();
			}

			/** Something changed: ask now instead of waiting for the next tick. */
			wake() {
				if (this.stopped) return;
				this.clearTimer();
				void this.run();
			}

			clearTimer() {
				if (this.timer === null) return;
				this.cancel(this.timer);
				this.timer = null;
			}

			async run(force) {
				if (this.stopped) return;
				if (this.busy) {
					this.rerun = true;
					return;
				}
				if (!force && !this.isVisible()) return;
				this.busy = true;
				try {
					await this.refresh();
				} finally {
					this.busy = false;
				}
				if (this.stopped) return;
				if (this.rerun) {
					this.rerun = false;
					void this.run();
					return;
				}
				if (!this.isVisible()) return;
				const delay = this.isActive() ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
				this.timer = this.schedule(() => {
					this.timer = null;
					void this.run();
				}, delay);
			}
		}

		class TaskConfirmController {
			constructor(ctx) {
				this.form = ctx.configForms.get(NS);
				this.status = null;
				this.statusError = "";
				this.statusFetchedAt = null;
				this.statusLoading = false;
				this.cancellingId = null;
				this.fetching = false;
				this.disposed = false;
				this.model = new primitives.SettingsFormModel(this.form, [
					booleanField("enabled"),
					primitives.settingsTextField("marker"),
					minutesField("pendingTtlMs"),
					listField("confirmWords"),
					listField("cancelWords"),
					listField("readOnlyTools"),
				]);
				this.store = client_store.createSnapshotStore(this.projection());
				this.unsubscribe = this.model
					.bind(() => this.model.shell())
					.subscribe(() => this.store.set(this.projection()));
			}

			projection() {
				const shell = this.model.shell();
				return {
					available: shell.available,
					writable: shell.writable,
					dirty: shell.dirty,
					invalid: shell.invalid,
					saving: shell.saving,
					failed: shell.failed,
					enabled: this.model.field("enabled").text === "true",
					marker: this.model.field("marker"),
					pendingTtlMs: this.model.field("pendingTtlMs"),
					confirmWords: this.model.field("confirmWords"),
					cancelWords: this.model.field("cancelWords"),
					readOnlyTools: this.model.field("readOnlyTools"),
					status: this.status,
					statusError: this.statusError,
					statusFetchedAt: this.statusFetchedAt,
					statusLoading: this.statusLoading,
					cancellingId: this.cancellingId,
				};
			}

			push() {
				if (!this.disposed) this.store.set(this.projection());
			}

			async refreshStatus() {
				if (this.disposed || this.fetching) return;
				this.fetching = true;
				if (!this.status) {
					this.statusLoading = true;
					this.push();
				}
				try {
					const response = await fetch(STATUS_URL, {
						credentials: "same-origin",
						headers: { accept: "application/json" },
						cache: "no-store",
					});
					if (!response.ok) {
						this.status = null;
						this.statusError =
							response.status === 404
								? "状态接口不可用（插件可能未启用或宿主版本不支持）。"
								: `读取状态失败（HTTP ${response.status}）。`;
					} else {
						const data = await response.json();
						if (data && Array.isArray(data.sessions)) {
							this.status = data;
							this.statusError = "";
							this.statusFetchedAt = Date.now();
						} else {
							this.status = null;
							this.statusError = "状态返回格式不正确。";
						}
					}
				} catch {
					this.status = null;
					this.statusError = "无法连接宿主，读取状态失败。";
				} finally {
					this.fetching = false;
					this.statusLoading = false;
					this.push();
				}
			}

			async cancelSession(sessionId) {
				if (this.cancellingId) return;
				this.cancellingId = sessionId;
				this.push();
				try {
					const response = await fetch(CANCEL_URL, {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId }),
					});
					if (!response.ok) this.statusError = `取消失败（HTTP ${response.status}）。`;
				} catch {
					this.statusError = "取消失败：无法连接宿主。";
				} finally {
					this.cancellingId = null;
					await this.refreshStatus();
				}
			}

			inject() {
				return {
					hooks: { taskConfirm: this.store },
					edit: (field, text) => this.model.actions().edit(field, text),
					resetField: (field) => this.model.actions().resetField(field),
					setEnabled: (enabled) =>
						this.model.actions().edit("enabled", enabled ? "true" : "false"),
					save: () => this.model.save(),
					discard: () => this.model.actions().discard(),
					refreshStatus: () => this.refreshStatus(),
					cancelSession: (sessionId) => this.cancelSession(sessionId),
				};
			}

			dispose() {
				this.disposed = true;
				this.unsubscribe();
				this.model.dispose();
			}
		}

		/**
		 * Render the settings page, or the one-liner the Plugins grid shows.
		 * @param props - slot view, hooks, staged-form actions, and form.
		 * @returns the summary text or the page.
		 */
		function TaskConfirmCard(props) {
			const state = props.useTaskConfirm((snapshot) => snapshot);
			const useSessionStatus = props.useSessionStatus;
			const statuses = typeof useSessionStatus === "function" ? useSessionStatus((value) => value) : undefined;
			const anyRunning = statuses
				? Array.from(statuses.values()).some((entry) => entry && entry.running === true)
				: false;

			const activeRef = react.useRef(anyRunning);
			activeRef.current = anyRunning;
			const refreshRef = react.useRef(null);
			refreshRef.current = () => props.refreshStatus();
			const schedulerRef = react.useRef(null);
			if (schedulerRef.current === null) {
				schedulerRef.current = new StatusRefreshScheduler({
					refresh: () => refreshRef.current(),
					isActive: () => activeRef.current,
					isVisible: () =>
						typeof document === "undefined" || document.visibilityState !== "hidden",
					schedule: (fn, ms) => setTimeout(fn, ms),
					cancel: (id) => clearTimeout(id),
				});
			}

			react.useEffect(() => {
				if (props.view !== "page") return undefined;
				const scheduler = schedulerRef.current;
				scheduler.start();
				const onVisibility = () => {
					if (typeof document !== "undefined" && document.visibilityState !== "hidden") {
						scheduler.wake();
					}
				};
				if (typeof document !== "undefined") {
					document.addEventListener("visibilitychange", onVisibility);
				}
				return () => {
					if (typeof document !== "undefined") {
						document.removeEventListener("visibilitychange", onVisibility);
					}
					scheduler.stop();
				};
			}, [props.view]);

			react.useEffect(() => {
				if (props.view !== "page" || !anyRunning) return;
				schedulerRef.current.wake();
			}, [anyRunning, props.view]);

			if (props.view === "summary") {
				return "需要动手的任务先给出任务理解，你确认后才执行。";
			}

			const disabled = !state.writable || state.saving;
			const field = (id, label, name, hint, invalidLabel, options) => {
				const extra = options || {};
				return react_jsx_runtime.jsx(primitives.SettingsValueField, {
					id,
					label,
					hint,
					overriddenLabel,
					resetLabel,
					invalidLabel,
					numeric: extra.numeric === true,
					disabled: disabled || extra.readOnly === true,
					...state[name],
					onEdit: (text) => props.edit(name, text),
					onReset: () => props.resetField(name),
				});
			};

			const status = state.status;
			const sessions = status && Array.isArray(status.sessions) ? status.sessions : [];
			const pending = sessions.filter((row) => row.phase === "pending").length;
			const confirmed = sessions.length - pending;
			const summary = status
				? `待确认 ${pending} · 已确认 ${confirmed}${status.enabled === false ? " · 插件已停用" : ""}`
				: state.statusLoading
					? "正在读取状态…"
					: "状态未读取";
			const modeText = anyRunning
				? `有会话运行中，每 ${Math.round(ACTIVE_REFRESH_MS / 1000)} 秒刷新`
				: `空闲，每 ${Math.round(IDLE_REFRESH_MS / 1000)} 秒检查一次`;
			const syncHint = state.statusError
				? state.statusError
				: `${modeText}${
						state.statusFetchedAt
							? ` · 更新于 ${new Date(state.statusFetchedAt).toLocaleTimeString("zh-CN")}`
							: ""
					}`;

			const statusSection = react_jsx_runtime.jsxs("div", {
				style: styles.panel,
				children: [
					react_jsx_runtime.jsxs("div", {
						style: styles.rowBetween,
						children: [
							react_jsx_runtime.jsx("div", { style: styles.title, children: "任务确认状态" }),
							react_jsx_runtime.jsx("div", { style: styles.summary, children: summary }),
						],
					}),
					react_jsx_runtime.jsx("p", {
						style: { ...styles.hint, margin: "2px 0 0" },
						children: syncHint,
					}),
					sessions.length === 0
						? react_jsx_runtime.jsx("p", {
								style: { ...styles.hint, margin: 0 },
								children: "当前没有待确认或执行中的会话。",
							})
						: react_jsx_runtime.jsx("div", {
								style: styles.rows,
								children: sessions.map((row) => {
									const cancelling = state.cancellingId === row.id;
									return react_jsx_runtime.jsxs(
										"div",
										{
											style: styles.row,
											children: [
												react_jsx_runtime.jsxs("div", {
													style: styles.rowText,
													children: [
														react_jsx_runtime.jsx("div", {
															style: styles.rowTitle,
															children: row.title || shortSessionId(row.id),
														}),
														react_jsx_runtime.jsx("div", {
															style: styles.hint,
															children: rowMeta(status, row),
														}),
													],
												}),
												react_jsx_runtime.jsx("button", {
													type: "button",
													style: cancelling
														? { ...styles.cancelButton, opacity: 0.6 }
														: styles.cancelButton,
													disabled: cancelling,
													onClick: () => props.cancelSession(row.id),
													children: cancelling ? "取消中…" : "取消",
												}),
											],
										},
										row.id,
									);
								}),
							}),
				],
			});

			const configSection = react_jsx_runtime.jsxs("div", {
				style: styles.panel,
				children: [
					react_jsx_runtime.jsx("div", { style: styles.title, children: "确认规则" }),
					react_jsx_runtime.jsx("p", {
						style: styles.hint,
						children: "保存后立即生效，无需重启；关闭任务确认会清空当前待确认状态。",
					}),
					react_jsx_runtime.jsxs("div", {
						style: styles.rowBetween,
						children: [
							react_jsx_runtime.jsxs("div", {
								children: [
									react_jsx_runtime.jsx("div", {
										style: { fontSize: "13px", lineHeight: 1.5 },
										children: "启用任务确认",
									}),
									react_jsx_runtime.jsx("div", {
										style: styles.hint,
										children: "关闭后不再注入协议、不再拦截工具。",
									}),
								],
							}),
							react_jsx_runtime.jsx(primitives.Switch, {
								checked: state.enabled,
								label: "启用任务确认",
								disabled,
								onChange: props.setEnabled,
							}),
						],
					}),
					field(
						"plugin-config-task-confirm-marker",
						"任务理解标记",
						"marker",
						"模型以该前缀开头的消息会被视为任务理解；留空回退到【任务理解】。",
						"请输入标记。",
					),
					field(
						"plugin-config-task-confirm-ttl",
						"待确认有效期（分钟）",
						"pendingTtlMs",
						"超过该时长没有人类回复就自动失效；0 表示不过期。默认 120。",
						"请输入 0–43200 的整数。",
						{ numeric: true },
					),
					field(
						"plugin-config-task-confirm-confirm-words",
						"确认词",
						"confirmWords",
						"整条消息精确匹配这些词才算确认；用顿号或逗号分隔。",
						"",
					),
					field(
						"plugin-config-task-confirm-cancel-words",
						"取消词",
						"cancelWords",
						"整条消息精确匹配这些词才算取消；用顿号或逗号分隔。",
						"",
					),
					field(
						"plugin-config-task-confirm-read-only",
						"确认前可用的工具",
						"readOnlyTools",
						"只读调研阶段的工具白名单，用顿号或逗号分隔；未列出的工具会被拒绝。",
						"",
					),
				],
			});

			return react_jsx_runtime.jsx(primitives.SettingsForm, {
				labels: formLabels,
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [statusSection, configSection],
			});
		}

		const inject = ["slots", "configForms"];

		function apply(ctx) {
			const controller = new TaskConfirmController(ctx);
			ctx.effect(
				() => () => controller.dispose(),
				"task-confirm: settings form",
			);
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NS], () =>
						ctx.slots.inject("plugins.item", () =>
							ctx.slots.register(
								{
									name: "plugins.item",
									id: NS,
									order: 31,
									label: () => "任务确认",
									inject: () => controller.inject(),
								},
								TaskConfirmCard,
							),
						),
					),
				"task-confirm: settings page",
			);
		}

		exports.inject = inject;
		exports.apply = apply;
		exports.StatusRefreshScheduler = StatusRefreshScheduler;
		return module.exports;
	},
});

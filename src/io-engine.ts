import { IoAdapter, StateChange, ValType, dateStr, valStr }		from './io-adapter';
import { IoSql, SqlHistoryRow, IoWriteCacheVal }				from './io-sql';
import { IoStates, AnyState }		from './io-state';
import { IoOperator }				from './io-operator';
import { Timer, TimerOpts }			from './io-timer';
import { sortBy }					from './io-util';


// ~~~~~~~~
// IoEngine
// ~~~~~~~~
export class IoEngine {
	private readonly	adapter									= IoAdapter.this;
	private readonly	logf									= IoAdapter.logf;
	private readonly	sql										= new IoSql();
	private				histNow									= 0;			// timestamp
	private readonly	histTimers:			Timer[]				= [];
	private readonly	histWriteCache:		IoWriteCacheVal[]	= [];

	/**
	 *
	 * @param adapter
	 */
	public constructor() {
		this.logf.debug('%-15s %-15s %-10s', this.constructor.name, 'constructor()', '');
	}

	/**
	 *
	 */
	public async start(historyDays: number): Promise<void> {
		const adapter = this.adapter;

		// create own folder objects
		await this.add_folders();

		// ~~~~~~~
		// HISTORY
		// ~~~~~~~
		const useHistory = (historyDays > 0) ? await this.sql_connect() : false;
		if (useHistory) {
			this.logf.debug('%-15s %-15s %-10s %-50s %.1f days', this.constructor.name, 'start()', 'history', '...', historyDays);
			IoOperator.setOnline(false);

			// optimize tables
			if (adapter.config['sql-optimize']) {
				await this.sql.optimizeTablesAsync();
			}

			// fromTs
			const fromTs = Date.now() - 1000*3600*24*historyDays;
			this.histNow = fromTs;

			// getNow()
			const getNow = (): number => {
				return this.histNow;
			};

			// setTimer()
			const setTimer = (opts: TimerOpts): Timer => {
				const timer = new Timer(opts);
				this.histTimers.push(timer);
				this.histTimers.sort(sortBy('expires'));
				return timer;
			}

			// clearTimer(timer)
			const clearTimer = (timer: Timer | null): null => {
				if (timer) {
					const idx = this.histTimers.indexOf(timer);
					if (idx >= 0) {
						if (timer.intervalId !== null  ||  timer.timeoutId !== null) {
							//this.logf.debug('%-15s %-15s %-10s %-50s %s',     this.constructor.name, 'delTimer()', 'delete', sprintf('%s %s (%0.3f h)', (timer.repeat ? 'interval' : 'timeout'), timer.name, timer.timeout_ms/1000/3600), dateStr(timer.expires));
						}
						this.histTimers.splice(idx, 1);

					} else {
						this.logf.error('%-15s %-15s %-10s %-50s %s\n%s', this.constructor.name, 'delTimer()', 'missing', '', dateStr(timer.expires), timer.toString());
					}
				}
				return null;
			}

			// init Timer
			Timer.init({ getNow, setTimer, clearTimer });

			// set IoStates.write()		-		called recursively
			IoStates.write = async (ioState: AnyState, val: ValType): Promise<void> => {
				const ts = this.histNow;
				if (ioState.writable) {
					this.logf.warn('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'write()', 'skipped', ioState.stateId, dateStr(ts), valStr(val));
				} else {
					//if (Date.now() - ts < 1000*60*20)		this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'write()', 'queued',  ioState.stateId, dateStr(ts), valStr(val));
					//this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'write()', '...', ioState.stateId, dateStr(ts), valStr(val));
					this.histWriteCache.push({ 'stateId': ioState.stateId, val, ts });
					await ioState.valSet(val, ts);			// will recursively call op.execute() -> op.exec() --> IoStates.write()
				}
			};

			// process history
			await this.hist_init({ fromTs });
			await this.hist_exec({ fromTs });

			// process pending OFFLINE timers
			await this.setNow(Date.now());
			await this.sql_flush();

			// close db connection
			await this.sql.onUnload();

			// init Timer
			Timer.init();
			await this.convertTimers();			// convert pending offline timers
			IoOperator.setOnline(true);

		// don't use history
		} else {
			this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'start()', 'online', '...');

			// init states
			for (const ioState of Object.values(IoStates.allStates)) {
				const valState = await adapter.readState(ioState.stateId);
				if (valState  &&  valState.val !== null) {
					ioState.valInit(valState.val, valState.ts);
				}
			}

			// init Timer
			Timer.init();
		}

		// ~~~~~
		// START
		// ~~~~~

		// IoState.write()
		IoStates.write = async (ioState: AnyState, val: ValType): Promise<void> => {
			const ts  =   Date.now();
			const ack = ! ioState.writable;
			if (ioState.logType === 'write') {
				this.logf.debug('%-15s %-15s %-10s %-50s %s   %s%s', ioState.constructor.name, 'write()', '', ioState.stateId, dateStr(ts), valStr(val), ack ? '' : ' cmd');
			}
			await adapter.writeState(ioState.stateId, { val, ack, ts });				// will call subscribed ack change handler
		};

		// subscribe iobroker state ack for all operator input states
		for (const stateId of Object.keys(IoStates.allStates).sort()) {
			const ioState = IoStates.allStates[stateId];
			if (ioState) {
				// subscribe iobroker state changes
				await adapter.subscribe({ stateId, 'ack': true, 'cb': async (stateChange: StateChange) => {
					if (ioState.logType === 'changed'  &&  stateChange.val !== ioState.val) {
						this.logf.debug('%-15s %-15s %-10s %-50s %s   %s%s', ioState.constructor.name, 'onChange()', ((stateChange.val === ioState.val) ? 'unchanged' : ''), stateId, dateStr(stateChange.ts), valStr(stateChange.val), stateChange.ack ? '' : ' cmd');
					}
					await ioState.valSet(stateChange.val, stateChange.ts);		// will recursively call op.execute() --> IoState.write()
				}});
			}
		}

		// started
		this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'start()', '', 'started');
	}


	private async hist_init({ fromTs }: { fromTs: number }): Promise<void> {
		const allStates = Object.values(IoStates.allStates).sort(sortBy('stateId'));
		const sqlOpts = { 'ack': true, 'isNull': false };

		for (const State of allStates) {
			let val: number | boolean | string;
			let ts:  number;
			const rows = await this.sql.readHistory([ State.stateId ], { 'before': fromTs, 'desc': true, 'limit': 1, ...sqlOpts });
			if (rows[0]) {
				ts  = rows[0].ts;
				val = rows[0].val;
			} else {
				const rows = await this.sql.readHistory([ State.stateId ], { 'from': fromTs, 'limit': 1, ...sqlOpts });
				if (rows[0]) {
					ts  = fromTs;
					val = rows[0].val;
				} else {
					const state = await this.adapter.readState(State.stateId);
					if (state  &&  state.val !== null) {
						ts  = fromTs;
						val = state.val;
					} else {
						throw new Error(`${this.constructor.name}: hist_init(): ${State.stateId}: not found`);
					}
				}
			}
			State.valInit(val, ts);
		}
	}

	/**
	 *
	 */
	public async hist_exec({ fromTs }: { fromTs: number }): Promise<void> {
		const srcStates: Record<string, AnyState> = {};			// by stateId
		const dstStates: Record<string, AnyState> = {};			// by stateId
		const skipped:   Record<string, AnyState> = {};			// by stateId

		// get srcStates, dstStates, skipped
		const allStates = Object.values(IoStates.allStates).sort(sortBy('stateId'));
		for (const state of allStates) {
			const isOutput  = (state.outputFrom.length > 0);
			const isHistSrc = (state.inputFor.length > 0)  &&  ! isOutput;		// state is input but not output
			const isHistDst = (! state.writable 		)  &&    isOutput;		// state is read only     output
			if (isHistSrc)  					{ srcStates[state.stateId] = state; }
			if (isHistDst)  					{ dstStates[state.stateId] = state; }
			if (! isHistSrc  &&  ! isHistDst)	{ skipped  [state.stateId] = state; }
		}

		// srcStateIds, dstStateIds
		const skippedIds  = Object.keys(skipped  ).sort();
		const srcStateIds = Object.keys(srcStates).sort();
		const dstStateIds = Object.keys(dstStates).sort();
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_exec()', 'skipped',   JSON.stringify(skippedIds,  null, 4));
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_exec()', 'srcStates', JSON.stringify(srcStateIds, null, 4));
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_exec()', 'dstStates', JSON.stringify(dstStateIds, null, 4));

		// processHist(srcRows), processed
		const processHist = async (srcRows: SqlHistoryRow[]): Promise<void> => {
			const now		= Date.now();
			const fromTs	= srcRows[0]?.ts;
			const untilTs	= srcRows.slice(-1)[0]?.ts;
			if (fromTs !== undefined  &&  untilTs !== undefined) {
				//this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s', this.constructor.name, 'processHist()', 'processing', `#${String(srcRows.length)}`, `until ${dateStr(untilTs)}`, 'from', dateStr(fromTs));
			}
			for (const row of srcRows) {
				if		(row.ts < this.histNow)  { this.logf.error('%-15s %-15s %-10s %-50s %s < %s', this.constructor.name, 'hist_exec()', 'row', row.id, dateStr(row.ts), dateStr(row.ts)); throw new Error(''); }
				else if (row.ts > this.histNow)  { await this.setNow(row.ts); }

				// process srcState
				const state = srcStates[row.id];
				if (state) {
					//this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'processHist()', '', state.stateId, dateStr(state.ts), valStr(state.val));
					await state.valSet(row.val, row.ts);		// will recursively call op.execute() --> IoState.write()
				}
			}
			if (fromTs !== undefined  &&  untilTs !== undefined) {
				this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s   (%4.1f s)', this.constructor.name, 'processHist()', 'processed', `#${String(srcRows.length)}`, `until ${dateStr(untilTs)}`, 'from', dateStr(fromTs), (Date.now() - now)/1000);
			}
		};

		// read sql history until Date.now()
		const TargetFlushMs				= 1000;
		let readLimit					= 1000;
		let processed:	Promise<void  >	= Promise.resolve();
		let flushed:	Promise<number>	= Promise.resolve(TargetFlushMs);		// resolves to flushTimeMs
		for (;;) {
			let now = Date.now();

			// wait until cached values are flushed
			const lastFlushMs = await flushed;

			// read up to ReadHistoryLimit rows of nonNull acknowledged state values
			readLimit = Math.round(readLimit * TargetFlushMs/lastFlushMs);		// estimate next readLimit
			readLimit = Math.max(1000, Math.min(50000, readLimit));				// 1000 <= readLimit <= 50000
			//this.logf.debug('%-15s %-15s %-10s %-43s %-6s %s', this.constructor.name, 'hist_exec()', 'reading', '...', 'from', dateStr(fromTs));
			const srcRows = await this.sql.readHistory(srcStateIds, {
				'from':			fromTs,
				'ack':			true,
				'isNull':		false,
				'limit':		readLimit,
			});
			let lastRow = srcRows.slice(-1)[0];
			if (! lastRow) {
				break;
			}
			let untilTs = lastRow.ts;
			this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s   (%4.1f s)', this.constructor.name, 'hist_exec()', 'read', `#${String(srcRows.length)}`, `until ${dateStr(untilTs)}`, 'from', dateStr(fromTs), (Date.now() - now)/1000);

			// remove latest row(s) if row limit reached ReadHistoryLimit and update untilTs
			if (srcRows.length === readLimit) {
				while (lastRow?.ts === untilTs) {
					srcRows.pop();
					lastRow = srcRows.slice(-1)[0];
				}
			}
			lastRow = srcRows.slice(-1)[0];
			if (! lastRow) {
				break;
			}

			// delete history of all histDst states
			now	= Date.now();
			untilTs	= lastRow.ts;
			//this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s', this.constructor.name, 'hist_exec()', 'deleting', '...', `until ${dateStr(untilTs)}`, 'from', dateStr(fromTs));
			const affectedRows = await this.sql.delHistory(dstStateIds, {		// don't await here
				'from':		fromTs,
				'until':	untilTs,
			});
			this.logf.debug('%-15s %-15s %-10s %-43s %-6s %s   (%4.1f s)', this.constructor.name, 'sql_flush()', 'deleted', `#${String(affectedRows['ts_number'] ?? 0)} ts_number, #${String(affectedRows['ts_bool'] ?? 0)} ts_bool`, 'from', dateStr(fromTs), (Date.now() - now)/1000);

			// start flushing cached values
			flushed = this.sql_flush();						// don't await here

			// process history
			await processed;
			processed = processHist(srcRows);

			fromTs = (untilTs + 1);
		}
		await processed;
	}


	/**
	 *
	 */
	public async sql_flush(): Promise<number> {
		const history	= this.histWriteCache.splice(0, this.histWriteCache.length);
		const now		= Date.now();
		const fromTs	= history[0]?.ts;
		const untilTs	= history.slice(-1)[0]?.ts ?? now;
		let   elapsedMs	= 0;
		if (fromTs !== undefined) {
			//this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s', this.constructor.name, 'hist_exec()', 'writing', `#${String(history.length)}`, `from ${dateStr(fromTs)}`, 'until', dateStr(untilTs));
			const affectedRows = await this.sql.writeHistory(history);
			elapsedMs = Date.now() - now;
			this.logf.debug('%-15s %-15s %-10s %-43s %-6s %s   (%4.1f s)', this.constructor.name, 'sql_flush()', 'written', `#${String(affectedRows['ts_number'] ?? 0)} ts_number, #${String(affectedRows['ts_bool'] ?? 0)} ts_bool`, 'until', dateStr(untilTs), elapsedMs/1000);
		}
		return elapsedMs;
	}

	/**
	 *
	 * @param nextNow
	 */
	private async setNow(nextNow: number): Promise<void> {
		// process offline timer timeouts					// histNow < expires <= nextNow
		while (this.histTimers[0]) {
			// next timeout's timer
			const timer = this.histTimers[0];				// (first) timer: { timeout, interval, expires, cb, ... }
			if (timer.expires > nextNow) {
				break;										// all offline timers processed
			}												// expires <= nextNow

			// debug log
			if (timer.expires < this.histNow) {				// histNow <= expires <= nextNow
				this.logf.error('%-15s %-15s %-10s expires - histNow = %6d <  0 %-18s %s\n%s', this.constructor.name, 'setNow()', 'error',	(timer.expires - this.histNow), '', dateStr(this.histNow), timer.toString());
			} else {
				//this.logf.debug('%-15s %-15s %-10s expires - histNow = %6d >= 0 %-18s %s %s', this.constructor.name, 'setNow()', '',		(timer.expires - this.histNow), '', dateStr(this.histNow), timer.name);
			}

			// set histNow, process timer timeout
			this.histNow = timer.expires;					// histNow := expires <= nextNow
			await timer.cb();

			// delete timer
			if (timer.interval === null) {
				this.histTimers.shift();

			// update expires
			} else {
				timer.expires += timer.interval;
				this.histTimers.sort(sortBy('expires'));
				//this.logf.debug('%-15s %-15s %-10s %-50s %s\n%s', this.constructor.name, 'setNow()', 'repeating', 'interval', dateStr(Timer.getNow()), timer2json(histTimer));
			}
		}

		// debug log
		if (this.histNow > nextNow) {						// nextNow - histNow < 0
			this.logf.error('%-15s %-15s %-10s nextNow - histNow < %6d %-20s %s', this.constructor.name, 'setNow()', 'error', (nextNow - this.histNow), '', dateStr(this.histNow));
		} else {
			//this.logf.debug('%-15s %-15s %-10s %-50s %s', this.constructor.name, 'setNow()', 'done', '', dateStr(nextNow));
		}

		this.histNow = nextNow;
	}


	/**
	 *
	 */
	private async convertTimers() {						// convert timers - must be called after update of getNow(), setTimer(), clearTimer()
		this.logf.debug('%-15s %-15s %-10s switching #%d timers from offline to online mode ...', this.constructor.name, 'convertTimers()', '', this.histTimers.length);

		// convert offline timer to online timer
		for (const timer of this.histTimers) {
			this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'convertTimers()', '', 'switching timer from offline to online mode', timer.toString());
			const { name, interval, expires, cb } = timer;
			const timeout = expires - Timer.now();

			// timeout
			if (interval === null) {
				if (timeout <= 0)	{	await cb();											}
				else				{	Timer.setTimer({ name, timeout,  cb });				}

			// interval
			} else {
				if (timeout <= 0)	{	await cb();
										Timer.setTimer({ name,          interval, cb });	}
				else				{	Timer.setTimer({ name, timeout, interval, cb });	}
			}
		}

		// remove offline timers
		this.histTimers.splice(0, this.histTimers.length);
	}

	/**
	 *
	 */
	public async sql_connect(): Promise<boolean> {
		// open db connection
		const instanceId	= `system.adapter.${this.adapter.historyId}`;
		const instanceObj	= await this.adapter.getForeignObjectAsync(instanceId);
		if (instanceObj) {
			// conntect to mariadb server
			const { dbtype, host, port, user, password, dbname } = instanceObj.native;
			if (       dbtype	=== 'mysql'		&&	typeof dbname	=== 'string'	&&
				typeof host		=== 'string'	&&	typeof port		=== 'number'	&&
				typeof user		=== 'string'	&&	typeof password	=== 'string'
			) {
				return this.sql.connect({ host, port, user, password, database: dbname });
			}
		}
		return false;
	}


	/**
	 *
	 */
	private async add_folders(): Promise<void> {
		const folderIds: string[] = [];

		for (const stateId of Object.keys(IoStates.allStates)) {
			if (stateId.startsWith(this.adapter.namespace)) {
				const path = stateId.split('.').slice(0, -1);
				if (path.length >= 3) {
					const folderId = path.join('.');
					if (!folderIds.includes(folderId)) {
						folderIds.push(folderId);
					}
				}
			}
		}

		for (const folderId of folderIds) {
			await this.adapter.writeFolderObj(folderId, {
				'name':		folderId.split('.').slice(-1)[0] ?? 'error'
			});
		}
	}
}

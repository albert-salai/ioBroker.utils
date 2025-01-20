import { IoAdapter, StateChange, ValType, dateStr, valStr }		from './io-adapter';
import { IoSql, SqlHistoryRow, IoWriteCacheVal }				from './io-sql';
import { IoStates, AnyState }		from './io-state';
import { IoOperator }				from './io-operator';
import { Timer, TimerOpts }			from './io-timer';
import { sortBy }					from './io-util';
import { sprintf }					from 'sprintf-js';


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
	private readonly	ReadSize								= 150000;
	private readonly	FlushMs									= 1000;			// 1 sec.
	private				flushedUntilTs							= 0;
	private 			flushSize								= 35000;		// ca. 1 sec.
	private				flushed:			Promise<void>		= Promise.resolve();
	private				flushStateIds:		string[]			= [];

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
			IoStates.write = this.hist_write_val.bind(this);

			// process history
			this.flushedUntilTs = (fromTs - 1);			// first flush will delete after 'flushedUntilTs'
			await this.hist_init({ fromTs });
			await this.hist_exec({ fromTs });

			// process pending OFFLINE timers
			await this.setNow(Date.now());
			await this.hist_flush();

			// close db connection
			await this.sql.onUnload();

			// init Timer
			Timer.init();
			await this.convertTimers();					// convert pending offline timers
			IoOperator.setOnline(true);

		// don't use history
		} else {
			this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'start()', 'online', '...');

			// init states
			for (const ioState of Object.values(IoStates.allStates)) {
				const valState = await adapter.readState(ioState.stateId);
				if (valState  &&  valState.val !== null) {
					this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'start()', 'state', ioState.stateId, dateStr(valState.ts), valStr(valState.val));
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

	/**
	 *
	 * @param param0
	 */
	private async hist_init({ fromTs }: { fromTs: number }): Promise<void> {
		this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'hist_init()', '', '...');
		const allStates = Object.values(IoStates.allStates).sort(sortBy('stateId'));
		const sqlOpts = { 'ack': true, 'isNull': false };

		for (const State of allStates) {
			let val: number | boolean | string;
			let ts:  number;
			const rows = await this.sql.readHistory([ State.stateId ], { 'before': fromTs, 'desc': true, 'limit': 1, ...sqlOpts });
			if (rows[0]) {
				ts  = rows[0].ts;
				val = rows[0].val;
				this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_init()', 'before',  State.stateId, dateStr(ts), valStr(val));
			} else {
				const rows = await this.sql.readHistory([ State.stateId ], { 'from': fromTs, 'limit': 1, ...sqlOpts });
				if (rows[0]) {
					ts  = fromTs;
					val = rows[0].val;
					this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_init()', 'after',  State.stateId, dateStr(ts), valStr(val));
				} else {
					const state = await this.adapter.readState(State.stateId);
					if (state  &&  state.val !== null) {
						ts  = fromTs;
						val = state.val;
						this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_init()', 'state',  State.stateId, dateStr(ts), valStr(val));
					} else {
						throw new Error(`${this.constructor.name}: hist_init(): ${State.stateId}: not found`);
					}
				}
			}
			if (ts <= 0) {
				this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_init()', 'ts invalid',  State.stateId, dateStr(State.ts), valStr(State.val));
				ts = fromTs;
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

		// debug log missing history datapoints
		const sqlStateIds = this.sql.stateIds();
		const dstStateIds = Object.keys(dstStates).sort();
		for (const stateId of dstStateIds.filter(dstStateId => ! sqlStateIds.includes(dstStateId))) {
			this.logf.warn('%-15s %-15s %-10s %-50s missing', this.constructor.name, 'hist_exec()', 'datapoint', stateId);
		}

		// srcStateIds, flushStateIds
		const skippedIds	= Object.keys(skipped  ).sort();
		const srcStateIds	= Object.keys(srcStates).sort();
		this.flushStateIds	= dstStateIds.filter(dstStateId => sqlStateIds.includes(dstStateId));
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_exec()', 'skipped',   JSON.stringify(skippedIds,			null, 4));
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_exec()', 'srcStates', JSON.stringify(srcStateIds, 		null, 4));
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_exec()', 'dstStates', JSON.stringify(this.flushStateIds,	null, 4));

		// read sql history until Date.now()
		const DaysLimit			= 7*6;						// 6 weeks
		const RowsLimit			= 1.5 * this.ReadSize;
		let   rowsPerDay		= 25000;					// [rows/day]	assuming 25000 rows/day
		let   rowsPeriodDays:	number;
		let   processed:		Promise<void>	= Promise.resolve();
		for (;;) {
			// rowsPeriodDays, beforeTs
			rowsPeriodDays	= Math.min(DaysLimit, this.ReadSize/rowsPerDay);		// rowsPeriodDays <= DaysLimit
			const beforeTs	= fromTs + 1000*3600*24*rowsPeriodDays;

			// sql.readHistory()
			this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s', this.constructor.name, 'hist_exec()', 'reading', sprintf('%.1f days', rowsPeriodDays), `before ${dateStr(beforeTs)}`, 'from', dateStr(fromTs));
			const now = Date.now();
			const srcRows = await this.sql.readHistory(srcStateIds, {
				'from':			fromTs,
				'before':		beforeTs,
				'ack':			true,
				'isNull':		false,
				'limit':		RowsLimit,
			});
			this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s   (%4.1f s)', this.constructor.name, 'hist_exec()', 'read', `#${String(srcRows.length)}`, `before ${dateStr(beforeTs)}`, 'from', dateStr(fromTs), (Date.now() - now)/1000);

			// break from loop
			if (srcRows.length === 0) {
				if (fromTs <= Date.now()) {
					rowsPerDay = this.ReadSize/DaysLimit;
				} else {
					break;
				}
			}

			// update rowsPerDay
			const firstTs = srcRows[0]?.ts;
			const lastTs  = srcRows.slice(-1)[0]?.ts;
			if (firstTs !== undefined  &&  lastTs !== undefined) {
				rowsPerDay = srcRows.length * 1000*3600*24/(lastTs - firstTs);
				if (srcRows.length === RowsLimit) {
					continue;
				}
			}

			// process history
			await processed;
			processed = this.hist_rows(srcRows, srcStates);
			await this.flushed;

			fromTs = beforeTs;
		}

		await processed;
		await this.hist_flush();
	}

	/**
	 *
	 * @param srcRows
	 * @param srcStates
	 */
	private async hist_rows(srcRows: SqlHistoryRow[], srcStates: Record<string, AnyState>): Promise<void> {
		const now		= Date.now();
		const fromTs	= srcRows          [0]?.ts;
		const untilTs	= srcRows.slice(-1)[0]?.ts;
		if (fromTs !== undefined  &&  untilTs !== undefined) {
			//this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s', this.constructor.name, 'hist_rows()', 'processing', `#${String(srcRows.length)}`, `until ${dateStr(untilTs)}`, 'from', dateStr(fromTs));
		}
		for (const row of srcRows) {
			if		(row.ts < this.histNow)  { this.logf.error('%-15s %-15s %-10s %-50s %s < %s', this.constructor.name, 'hist_exec()', 'row', row.id, dateStr(row.ts), dateStr(row.ts)); throw new Error(''); }
			else if (row.ts > this.histNow)  { await this.setNow(row.ts); }

			// process srcState
			const state = srcStates[row.id];
			if (state) {
				//this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_rows()', '', state.stateId, dateStr(state.ts), valStr(state.val));
				await state.valSet(row.val, row.ts);		// will recursively call op.execute() --> IoState.write()
			}
		}
		if (fromTs !== undefined  &&  untilTs !== undefined) {
			this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s   (%4.1f s)', this.constructor.name, 'hist_rows()', 'processed', `#${String(srcRows.length)}`, `until ${dateStr(untilTs)}`, 'from', dateStr(fromTs), (Date.now() - now)/1000);
		}
	}

	/**
	 *
	 * @param ioState
	 * @param val
	 */
	private async hist_write_val(ioState: AnyState, val: ValType): Promise<void> {
		const ts = this.histNow;
		if (ioState.writable) {
			this.logf.warn('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_write_val()', 'skipped', ioState.stateId, dateStr(ts), valStr(val));

		} else {
			//if (Date.now() - ts < 1000*60*20)		this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_write_val()', 'queued',  ioState.stateId, dateStr(ts), valStr(val));
			//this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_write_val()', '...', ioState.stateId, dateStr(ts), valStr(val));
			await ioState.valSet(val, ts);		// recursion: valSet() --> op.exec() --> op.execute() --> IoStates.write() --> hist_write_val() --> valSet()

			const len = this.histWriteCache.push({ 'stateId': ioState.stateId, val, ts });
			if (len >= this.flushSize) {
				await  this.flushed;
				this.flushed = this.hist_flush();
			}
		}
	}

	/**
	 *
	 */
	private async hist_flush(): Promise<void> {
		const history = this.histWriteCache.splice(0, this.histWriteCache.length);
		const flushFromTs	= history          [0]?.ts;
		const flushUntilTs  = history.slice(-1)[0]?.ts;
		if (flushFromTs !== undefined  &&  flushUntilTs !== undefined) {

			// delAfterTs, delUntilTs
			const delAfterTs	= this.flushedUntilTs;
			const delUntilTs	= flushUntilTs;
			this.flushedUntilTs	= flushUntilTs;

			// delete history
			//this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s', this.constructor.name, 'hist_flush()', 'deleting', '...', `until  ${dateStr(delUntilTs)}`, 'after', dateStr(delAfterTs));
			let now = Date.now();
			/* const affectedRows =*/ await this.sql.delHistory(this.flushStateIds, {
				'after':	delAfterTs,
				'until':	delUntilTs,
			});
			//this.logf.debug('%-15s %-15s %-10s %-43s %-6s %s   (%4.1f s)', this.constructor.name, 'hist_flush()', 'deleted', `#${String(affectedRows['ts_number'] ?? 0)} ts_number, #${String(affectedRows['ts_bool'] ?? 0)} ts_bool`, 'after', dateStr(delAfterTs), (Date.now() - now)/1000);

			// sql.writeHistory()
			//this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s', this.constructor.name, 'hist_flush()', 'writing', `#${String(history.length)}`, `until ${dateStr(flushUntilTs)}`, 'from', dateStr(flushFromTs));
			now = Date.now();
			return this.sql.writeHistory(history).then((_affectedRows: Record<string, number>) => {
				const elapsedMs = Date.now() - now;
				this.logf.debug('%-15s %-15s %-10s %-43s %-6s %s   (%4.1f s)', this.constructor.name, 'hist_flush()', 'written', `#${String(_affectedRows['ts_number'] ?? 0)} ts_number, #${String(_affectedRows['ts_bool'] ?? 0)} ts_bool`, 'from', dateStr(flushFromTs), elapsedMs/1000);

				// 10000 <= histFlushSize <= 50000
				const flushSize = Math.max(10000, Math.min(50000, this.flushSize * this.FlushMs/Math.max(200, elapsedMs)));
				this .flushSize = (flushSize + this.flushSize*3)/4;
			});
		}
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

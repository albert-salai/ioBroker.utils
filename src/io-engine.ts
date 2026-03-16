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
	private static 		ReadDaysLimit							= 7*6;						// 6 weeks

	private readonly	adapter									= IoAdapter.this;
	private readonly	logf									= IoAdapter.logf;
	private readonly	sql										= new IoSql();
	private				histNow									= 0;			// simulated clock during history replay
	private readonly	histTimers:			Timer[]				= [];
	private readonly	histWriteCache:		IoWriteCacheVal[]	= [];
	private readonly	ReadSize								= 150000;
	private readonly	FlushMs									= 1000;
	private 			flushSize								= 35000;		// calibrated to ~1 sec flush time
	private				flushed:			Promise<void>		= Promise.resolve();

	public constructor() {
		this.logf.debug('%-15s %-15s %-10s', this.constructor.name, 'constructor()', '');
	}


	public async start(historyDays: number): Promise<void> {
		const adapter	= this.adapter;
		const allStates	= Object.values(IoStates.registry).sort(sortBy('stateId'));

		await this.add_folders(allStates);

		// history replay or online mode
		const useHistory = (historyDays > 0) ? await this.sql_connect() : false;
		if (useHistory) {
			if (adapter.config['sql-optimize']) {
				await this.sql.optimizeTablesAsync();
			}

			IoOperator.setLive(false);
			await this.process_hist(historyDays, allStates);
			await this.sql.onUnload();
			IoOperator.setLive(true);

		} else {
			Timer.configure();

			// init: seed each state from its current ioBroker value
			for (const ioState of allStates) {
				const state = await this.adapter.readState(ioState.stateId);
				if (state  &&  state.val !== null) {
					ioState.seed(state.val, state.ts);
				}
			}
		}

		// IoState.write(): route writes through the adapter; ack=false signals a command
		IoStates.writeFn = async (ioState: AnyState, val: ValType): Promise<void> => {
			const ts  =   Date.now();
			const ack = ! ioState.writable;
			if (ioState.logType === 'write') {
				this.logf.debug('%-15s %-15s %-10s %-50s %s   %s%s', ioState.constructor.name, 'write()', '', ioState.stateId, dateStr(ts), valStr(val), ack ? '' : ' cmd');
			}
			await adapter.writeState(ioState.stateId, { val, ack, ts });		// will call subscribed ack change handler
		};

		// subscribe ack changes so operators re-execute on external state updates
		for (const ioState of allStates) {
			await adapter.subscribe({ 'stateId': ioState.stateId, 'ack': true, 'cb': async (state: StateChange) => {
				if (ioState.logType === 'changed'  &&  state.val !== ioState.val) {
					this.logf.debug('%-15s %-15s %-10s %-50s %s   %s%s', ioState.constructor.name, 'onChange()', ((state.val === ioState.val) ? 'unchanged' : ''), ioState.stateId, dateStr(state.ts), valStr(state.val), state.ack ? '' : ' cmd');
				}
				await ioState.onStateChange(state.val, state.ts);		// will recursively call op.execute() --> IoState.write()
			}});
		}

		this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'start()', 'done', '');
	}


	private async process_hist(historyDays: number, allStates: AnyState[]): Promise<void> {
		const adapter = this.adapter;
		this.logf.debug('%-15s %-15s %-10s %-50s %.1f days', this.constructor.name, 'process_hist()', '', '...', historyDays);

		const fromTs = Date.now() - 1000*3600*24*historyDays;
		this.histNow = fromTs;

		// redirect Timer and IoStates.writeFn to offline (simulated-clock) implementations
		Timer.configure({
			'setTimer':		this.hist_setTimer  .bind(this),
			'clearTimer':	this.hist_clearTimer.bind(this),
			'now':			this.hist_now    	.bind(this),
		});
		IoStates.writeFn = this.hist_write.bind(this);

		// srcStates: have real SQL history to replay; dstStates: read-only computed outputs
		const srcStates: Record<string, AnyState>	= {};		// by stateId
		const dstStates: Record<string, AnyState>	= {};		// by stateId
		for (const ioState of allStates) {
			const isDst = (ioState.writtenByOperators.length > 0)  &&  (! ioState.writable);
			if (isDst)	dstStates[ioState.stateId] = ioState;
			else		srcStates[ioState.stateId] = ioState;
		}
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'process_hist()', 'srcStates', JSON.stringify(Object.keys(srcStates), 		null, 4));
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'process_hist()', 'dstStates', JSON.stringify(Object.keys(dstStates),		null, 4));

		// warn about dstStates with no SQL datapoint (replay will silently skip them)
		const sqlStateIds = this.sql.stateIds();
		const dstStateIds = Object.keys(dstStates).sort();
		for (const stateId of dstStateIds.filter(dstStateId => ! sqlStateIds.includes(dstStateId))) {
			this.logf.warn('%-15s %-15s %-10s %-50s missing', this.constructor.name, 'process_hist()', 'datapoint', stateId);
		}

		// delete existing dstState history in chunks to avoid large single-transaction locks
		this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'hist_flush()', 'deleting', `from  ${dateStr(fromTs)}`);
		const deletePeriodMs = 1000*3600*24 * IoEngine.ReadDaysLimit/2;
		for (let deleteFrom = fromTs; deleteFrom <= Date.now(); deleteFrom += deletePeriodMs) {
			const affectedRows = await this.sql.delHistory(dstStateIds, { 'from': deleteFrom, 'before': (deleteFrom + deletePeriodMs) });
			if ((affectedRows['ts_number'] ?? 0) + (affectedRows['ts_bool'] ?? 0) > 0) {
				this.logf.debug('%-15s %-15s %-10s %7d number %5d bool  %s ... %s', this.constructor.name, 'hist_flush()', 'deleted', affectedRows['ts_number'] ?? 0, affectedRows['ts_bool'] ?? 0, dateStr(deleteFrom), dateStr(deleteFrom + deletePeriodMs));
			}
		}

		// replay: first flush deletes from fromTs, then exec drives hist_write
		await this.hist_init(fromTs, allStates);
		await this.hist_exec(fromTs, srcStates);

		// advance simulated clock to wall time and fire any pending offline timers
		await this.hist_setNow(Date.now());
		Timer.configure();
		await this.hist_convertTimers();			// convert pending offline timers, may call timer callbacks
		IoOperator.setLive(true);

		// flush remaining buffered history writes
		await this.flushed;
		await this.hist_flush();

		// avoid SQL duplicate-timestamp error if dstState value diverged during replay
		for (const dstState of Object.values(dstStates)) {
			const state = await adapter.readState(dstState.stateId);
			if (state  &&  state.val !== null  &&  state.val !== dstState.val) {
				await this.sql.delHistory([ dstState.stateId ], { 'from': dstState.ts, 'until': dstState.ts });
				await adapter.writeState(dstState.stateId, { 'val': dstState.val, 'ack': true, 'ts': dstState.ts });
			}
		}

		// sync srcStates that changed in ioBroker while history was being processed
		for (const srcState of Object.values(srcStates)) {
			const state = await adapter.readState(srcState.stateId);
			if (state  &&  state.val !== null  &&  state.val !== srcState.val) {
				this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'process_hist()', 'update', srcState.stateId, dateStr(state.ts), valStr(state.val));
				await srcState.onStateChange(state.val, state.ts);
			}
		}
	}


	private async hist_init(fromTs: number, ioStates: AnyState[]): Promise<void> {
		this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'hist_init()', '', '...');
		const sqlOpts = { 'ack': true, 'isNull': false };

		for (const ioState of ioStates) {
			let val: number | boolean | string;
			let ts:  number;

			// priority: last value before window > first value in window > current ioBroker state
			const rows = await this.sql.readHistory([ ioState.stateId ], { 'before': fromTs, 'desc': true, 'limit': 1, ...sqlOpts });
			if (rows[0]) {
				ts  = rows[0].ts;
				val = rows[0].val;
				this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_init()', 'before',  ioState.stateId, dateStr(ts), valStr(val));

			} else {
				const rows = await this.sql.readHistory([ ioState.stateId ], { 'from': fromTs, 'limit': 1, ...sqlOpts });
				if (rows[0]) {
					ts  = fromTs;
					val = rows[0].val;
					this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_init()', 'after',  ioState.stateId, dateStr(ts), valStr(val));

				} else {
					const state = await this.adapter.readState(ioState.stateId);
					if (state  &&  state.val !== null) {
						val = state.val;
						ts  = state.ts;
						this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_init()', 'state',  ioState.stateId, dateStr(ts), valStr(val));
						await this.adapter.writeState(ioState.stateId, { val, ts, 'ack': true });

					} else {
						throw new Error(`${this.constructor.name}: hist_init(): ${ioState.stateId}: not found`);
					}
				}
			}

			if (ts <= 0) {
				this.logf.error('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_init()', 'ts invalid',  ioState.stateId, dateStr(ioState.ts), valStr(ioState.val));
				ts = fromTs;
			}

			ioState.seed(val, ts);
		}
	}


	private async hist_exec(fromTs: number, srcStates: Record<string, AnyState>): Promise<void> {
		const srcStateIds = Object.keys(srcStates).sort();

		// adaptive read: start at 25000 rows/day, adjust based on observed density
		const RowsLimit			= 1.5 * this.ReadSize;
		let   rowsPerDay		= 25000;					// [rows/day] initial estimate
		let   rowsPeriodDays:	number;
		let   processed:		Promise<void>	= Promise.resolve();
		for (;;) {
			await new Promise((res, _rej) => setTimeout(res, 100));

			// rowsPeriodDays capped at ReadDaysLimit to bound single SQL query size
			rowsPeriodDays	= Math.min(IoEngine.ReadDaysLimit, this.ReadSize/rowsPerDay);
			const beforeTs	= fromTs + 1000*3600*24*rowsPeriodDays;

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

			if (srcRows.length === 0) {
				if (fromTs <= Date.now()) {
					// gap in data: keep advancing at minimum density rather than breaking
					rowsPerDay = this.ReadSize/IoEngine.ReadDaysLimit;
				} else {
					break;
				}
			}

			// if RowsLimit hit, re-read with narrower window before processing
			const firstTs = srcRows[0]?.ts;
			const lastTs  = srcRows.slice(-1)[0]?.ts;
			if (firstTs !== undefined  &&  lastTs !== undefined) {
				rowsPerDay = srcRows.length * 1000*3600*24/(lastTs - firstTs);
				if (srcRows.length === RowsLimit) {
					continue;
				}
			}

			// process previous batch concurrently with current read
			await processed;
			processed = this.hist_execRows(srcRows, srcStates);

			fromTs = beforeTs;
		}

		await processed;
	}


	private async hist_execRows(srcRows: SqlHistoryRow[], srcStates: Record<string, AnyState>): Promise<void> {
		for (const row of srcRows) {
			if		(row.ts < this.histNow)  { this.logf.error('%-15s %-15s %-10s %-50s %s < %s', this.constructor.name, 'hist_exec()', 'row', row.id, dateStr(row.ts), dateStr(this.histNow)); throw new Error(''); }
			else if (row.ts > this.histNow)  { await this.hist_setNow(row.ts); }

			const state = srcStates[row.id];
			if (state) {
				await state.onStateChange(row.val, row.ts);						// will recursively call op.execute() --> IoState.write()
				await new Promise((res, _rej) => setImmediate(res));		// yield to allow logging between rows
			}
		}
	}


	private async hist_write(ioState: AnyState, val: ValType): Promise<void> {
		const ts = this.histNow;
		await ioState.onStateChange(val, ts);		// recursion: onStateChange() --> op.onTrigger() --> op.execute() --> IoStates.writeFn() --> hist_write() --> onStateChange()

		// only buffer read-only outputs; skip writable states (commands have no SQL history)
		if (! ioState.writable) {
			const len = this.histWriteCache.push({ 'stateId': ioState.stateId, val, ts });
			if (len >= this.flushSize) {
				await this.flushed;
				this.flushed = this.hist_flush();
			}
		}
	}


	private async hist_flush(): Promise<void> {
		const history		= this.histWriteCache.splice(0, this.histWriteCache.length);
		const flushFromTs	= history          [0]?.ts;
		const flushUntilTs  = history.slice(-1)[0]?.ts;
		if (flushFromTs !== undefined  &&  flushUntilTs !== undefined) {
			const now = Date.now();
			const affectedRows = await this.sql.writeHistory(history);
			const elapsedMs = Date.now() - now;
			this.logf.debug('%-15s %-15s %-10s %-43s %-6s %s   (%4.1f s)', this.constructor.name, 'hist_flush()', 'written', `#${String(affectedRows['ts_number'] ?? 0)} ts_number, #${String(affectedRows['ts_bool'] ?? 0)} ts_bool`, 'from', dateStr(flushFromTs), elapsedMs/1000);

			// clamp flushSize to 10000–50000; exponential moving average weights toward stable throughput
			const flushSize = Math.max(10000, Math.min(50000, this.flushSize * this.FlushMs/Math.max(200, elapsedMs)));
			this .flushSize = (flushSize + this.flushSize*3)/4;
		}
	}


	private hist_setTimer(opts: TimerOpts): Timer {
		const timer = new Timer(opts);
		this.histTimers.push(timer);
		this.histTimers.sort(sortBy('expireTs'));
		return timer;
	}


	private hist_clearTimer(timer: Timer | null): null {
		if (timer) {
			const idx = this.histTimers.indexOf(timer);
			if (idx >= 0) {
				this.histTimers.splice(idx, 1);
			} else {
				this.logf.error('%-15s %-36s %-50s %s\n%s', this.constructor.name, 'hist_clearTimer()', 'missing', dateStr(timer.expireTs), JSON.stringify(timer, null, 4));
			}
		}
		return null;
	}


	private hist_now() {
		return this.histNow;
	}


	private async hist_setNow(nextNow: number): Promise<void> {
		// fire all offline timers whose expireTs falls within (histNow, nextNow]
		while (this.histTimers[0]) {
			const timer = this.histTimers[0];
			if (timer.expireTs > nextNow) {
				break;
			}

			if (timer.expireTs < this.histNow) {			// invariant violation: expireTs must be >= histNow
				this.logf.error('%-15s %-15s %-10s expires - histNow = %6d <  0 %-18s %s\n%s', this.constructor.name, 'hist_setNow()', 'error',	(timer.expireTs - this.histNow), '', dateStr(this.histNow), JSON.stringify(timer, null, 4));
				timer.expireTs = this.histNow;
			}

			this.histNow = timer.expireTs;
			await timer.cb();

			// reschedule interval or remove one-shot timer
			if (timer.intervalMs !== null) {
				timer.timeoutMs    = null;
				timer.expireTs += timer.intervalMs;
				this.histTimers.sort(sortBy('expireTs'));
			} else {
				this.histTimers.shift();
			}
		}

		this.histNow = nextNow;
	}


	/** Must be called after Timer.configure() to activate converted timers. */
	private async hist_convertTimers(): Promise<void> {
		// convert offline timers to live timers; fire immediately if already expired
		for (const timer of this.histTimers) {
			const { name, cb, expireTs, intervalMs } = timer;
			this.logf.debug('%-15s %-26s %-50s %s', this.constructor.name, 'hist_convertTimers()', `converting timer ${timer.name}`, dateStr(expireTs));

			const timeoutMs = expireTs - Timer.now();
			if (intervalMs === null) {
				if (timeoutMs <= 0)	{	await cb();									}
				else				{	Timer.setTimer({ name, timeoutMs, cb });	}

			} else {
				if (timeoutMs <= 0)	{	await cb();
										Timer.setTimer({ name,        		intervalMs, cb });	}
				else				{	Timer.setTimer({ name, timeoutMs,	intervalMs, cb });	}
			}
		}

		this.histTimers.splice(0, this.histTimers.length);
	}


	private async sql_connect(): Promise<boolean> {
		// only mysql/mariadb is supported; other dbtypes return false rather than throw
		const instanceId	= `system.adapter.${this.adapter.historyId}`;
		const instanceObj	= await this.adapter.getForeignObjectAsync(instanceId);
		if (instanceObj) {
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


	private async add_folders(ioStates: AnyState[]): Promise<void> {
		const folderIds: string[] = [];

		for (const stateId of ioStates.map(ioState => ioState.stateId)) {
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

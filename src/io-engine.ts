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
	private				flushedUntilTs							= 0;			// flush will delete AFTER flushedUntilTs
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

		// start_history() or start_online()
		const useHistory = (historyDays > 0) ? await this.sql_connect() : false;
		if (useHistory) {
			// optimize tables
			if (adapter.config['sql-optimize']) {
				await this.sql.optimizeTablesAsync();
			}

			// process history
			IoOperator.setOnline(false);
			await this.start_history(historyDays);
			await this.sql.onUnload();
			IoOperator.setOnline(true);

		} else {
			await this.start_online();
		}

		// IoState.write()
		IoStates.write = async (ioState: AnyState, val: ValType): Promise<void> => {
			const ts  =   Date.now();
			const ack = ! ioState.writable;
			if (ioState.logType === 'write') {
				this.logf.debug('%-15s %-15s %-10s %-50s %s   %s%s', ioState.constructor.name, 'write()', '', ioState.stateId, dateStr(ts), valStr(val), ack ? '' : ' cmd');
			}
			await adapter.writeState(ioState.stateId, { val, ack, ts });		// will call subscribed ack change handler
		};

		// subscribe iobroker state changes
		const allStates = Object.values(IoStates.allStates).sort(sortBy('stateId'));
		for (const ioState of allStates) {
			await adapter.subscribe({ 'stateId': ioState.stateId, 'ack': true, 'cb': async (state: StateChange) => {
				if (ioState.logType === 'changed'  &&  state.val !== ioState.val) {
					this.logf.debug('%-15s %-15s %-10s %-50s %s   %s%s', ioState.constructor.name, 'onChange()', ((state.val === ioState.val) ? 'unchanged' : ''), ioState.stateId, dateStr(state.ts), valStr(state.val), state.ack ? '' : ' cmd');
				}
				await ioState.update(state.val, state.ts);		// will recursively call op.execute() --> IoState.write()
			}});
		}

		// started
		this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'start()', '', 'started');
	}


	/**
	 *
	 */
	public async start_online(): Promise<void> {
		this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'start_online()', '', '...');

		// init Timer
		Timer.init();

		// init ioStates
		const ioStates = Object.values(IoStates.allStates).sort(sortBy('stateId'));
		for (const ioState of ioStates) {
			const state = await this.adapter.readState(ioState.stateId);
			if (state  &&  state.val !== null) {
				ioState.init(state.val, state.ts);
			}
		}
	}


	/**
	 *
	 * @param historyDays
	 */
	public async start_history(historyDays: number): Promise<void> {
		const adapter = this.adapter;
		this.logf.debug('%-15s %-15s %-10s %-50s %.1f days', this.constructor.name, 'start_history()', '', '...', historyDays);

		// fromTs, histNow
		const fromTs = Date.now() - 1000*3600*24*historyDays;
		this.histNow = fromTs;

		// Timer: init
		Timer.init({
			'getNow':		this.hist_getNow    .bind(this),
			'setTimer':		this.hist_setTimer  .bind(this),
			'clearTimer':	this.hist_clearTimer.bind(this),
		});

		// IoStates: write()		-		called recursively
		IoStates.write = this.hist_write.bind(this);

		// srcStates, dstStates, skipped
		const allStates = Object.values(IoStates.allStates).sort(sortBy('stateId'));
		const srcStates: 		Record<string, AnyState>	= {};		// by stateId
		const dstStates: 		Record<string, AnyState>	= {};		// by stateId
		const skippedStates:	Record<string, AnyState>	= {};		// by stateId
		for (const state of allStates) {
			if (state.outputFrom.length > 0) {
				if (state.writable)					{ srcStates[state.stateId]		= state; }		// writable  output
				else								{ dstStates[state.stateId]		= state; }		// read-only output
			}
			else if (state.sourceFor.length > 0)	{ srcStates[state.stateId]		= state; }		// input but not output
			else									{ skippedStates[state.stateId]	= state; }		// skipped
		}
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_exec()', 'skipped',   JSON.stringify(Object.keys(skippedStates),	null, 4));
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_exec()', 'srcStates', JSON.stringify(Object.keys(srcStates), 		null, 4));
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_exec()', 'dstStates', JSON.stringify(Object.keys(dstStates),		null, 4));

		// process history							// first flush shall delete from  'fromTs'
		this.flushedUntilTs = (fromTs - 1);			// first flush will  delete after 'flushedUntilTs'
		await this.hist_init(fromTs);
		await this.hist_exec(fromTs, srcStates, dstStates);

		// process pending OFFLINE timers
		await this.hist_setNow(Date.now());
		await this.hist_flush();

		// Timer: init
		Timer.init();
		await this.hist_convertTimers();			// convert pending offline timers
		IoOperator.setOnline(true);

		// write read-only output ioState val to iobroker state
		for (const ioState of Object.values(dstStates)) {
			const state = await adapter.readState(ioState.stateId);
			if (state  &&  state.val !== null  &&  state.val !== ioState.val) {
				this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'start()', 'write', ioState.stateId, dateStr(ioState.ts), valStr(ioState.val));
				await this.sql.delHistory([ ioState.stateId ], { 'from': ioState.ts, 'until': ioState.ts });			// avoid sql error for existing timestamp
				await adapter.writeState(ioState.stateId, { 'val': ioState.val, 'ack': true, 'ts': ioState.ts });		// write state to iobroker
			}
		}

		// init ioState with iobroker state val
		for (const ioState of Object.values(skippedStates)) {
			const state = await adapter.readState(ioState.stateId);
			if (state  &&  state.val !== null  &&  state.val !== ioState.val) {
				this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'start()', 'init', ioState.stateId, dateStr(state.ts), valStr(state.val));
				ioState.init(state.val, state.ts);
			}
		}

		// update input-only ioState if iobroker state changed
		for (const ioState of Object.values(srcStates)) {
			const state = await adapter.readState(ioState.stateId);
			if (state  &&  state.val !== null  &&  state.val !== ioState.val) {
				this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'start()', 'update', ioState.stateId, dateStr(state.ts), valStr(state.val));
				await ioState.update(state.val, state.ts);
			}
		}
	}


	/**
	 *
	 * @param fromTs
	 */
	private async hist_init(fromTs: number): Promise<void> {
		this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'hist_init()', '', '...');
		const sqlOpts = { 'ack': true, 'isNull': false };

		const allStates = Object.values(IoStates.allStates).sort(sortBy('stateId'));
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
			State.init(val, ts);
		}
	}


	/**
	 *
	 * @param fromTs
	 */
	public async hist_exec(fromTs: number, srcStates: Record<string, AnyState>, dstStates: Record<string, AnyState>): Promise<void> {
		// debug log missing history datapoints
		const sqlStateIds = this.sql.stateIds();
		const dstStateIds = Object.keys(dstStates).sort();
		for (const stateId of dstStateIds.filter(dstStateId => ! sqlStateIds.includes(dstStateId))) {
			this.logf.warn('%-15s %-15s %-10s %-50s missing', this.constructor.name, 'hist_exec()', 'datapoint', stateId);
		}

		// srcStateIds, flushStateIds
		const srcStateIds	= Object.keys(srcStates).sort();
		this.flushStateIds	= dstStateIds.filter(dstStateId => sqlStateIds.includes(dstStateId));

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
			processed = this.hist_execRows(srcRows, srcStates);
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
	private async hist_execRows(srcRows: SqlHistoryRow[], srcStates: Record<string, AnyState>): Promise<void> {
		//const now		= Date.now();
		const fromTs	= srcRows          [0]?.ts;
		const untilTs	= srcRows.slice(-1)[0]?.ts;
		if (fromTs !== undefined  &&  untilTs !== undefined) {
			//this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s', this.constructor.name, 'hist_execRows()', 'processing', `#${String(srcRows.length)}`, `until ${dateStr(untilTs)}`, 'from', dateStr(fromTs));
		}
		for (const row of srcRows) {
			if		(row.ts < this.histNow)  { this.logf.error('%-15s %-15s %-10s %-50s %s < %s', this.constructor.name, 'hist_exec()', 'row', row.id, dateStr(row.ts), dateStr(row.ts)); throw new Error(''); }
			else if (row.ts > this.histNow)  { await this.hist_setNow(row.ts); }

			// process srcState
			const state = srcStates[row.id];
			if (state) {
				//this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_execRows()', '', state.stateId, dateStr(state.ts), valStr(state.val));
				await state.update(row.val, row.ts);		// will recursively call op.execute() --> IoState.write()
			}
		}
		if (fromTs !== undefined  &&  untilTs !== undefined) {
			//this.logf.debug('%-15s %-15s %-10s %-14s %-28s %-6s %s   (%4.1f s)', this.constructor.name, 'hist_execRows()', 'processed', `#${String(srcRows.length)}`, `until ${dateStr(untilTs)}`, 'from', dateStr(fromTs), (Date.now() - now)/1000);
		}
	}


	/**
	 *
	 * @param ioState
	 * @param val
	 */
	private async hist_write(ioState: AnyState, val: ValType): Promise<void> {
		const ts = this.histNow;
		await ioState.update(val, ts);		// recursion: update() --> op.exec() --> op.execute() --> IoStates.write() --> hist_write() --> update()

		// add {stateId, val, ts} to write cache
		if (! ioState.writable) {
			const len = this.histWriteCache.push({ 'stateId': ioState.stateId, val, ts });
			if (len >= this.flushSize) {
				await  this.flushed;
				this.flushed = this.hist_flush();
			}
		} else {
			//this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'hist_write()', 'skipped', ioState.stateId, dateStr(ts), valStr(val));
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
	 * @param opts
	 * @returns
	 */
	private hist_setTimer(opts: TimerOpts): Timer {
		const timer = new Timer(opts);
		this.histTimers.push(timer);
		this.histTimers.sort(sortBy('expires'));
		return timer;
	}


	/**
	 *
	 * @param timer
	 * @returns
	 */
	private hist_clearTimer(timer: Timer | null): null {
		if (timer) {
			const idx = this.histTimers.indexOf(timer);
			if (idx >= 0) {
				this.histTimers.splice(idx, 1);
			} else {
				this.logf.error('%-15s %-15s %-10s %-50s %s\n%s', this.constructor.name, 'delTimer()', 'missing', '', dateStr(timer.expires), timer.toString());
			}
		}
		return null;
	}


	/**
	 *
	 * @returns
	 */
	private hist_getNow() {
		return this.histNow;
	}


	/**
	 *
	 * @param nextNow
	 */
	private async hist_setNow(nextNow: number): Promise<void> {
		// process offline timer timeouts					// histNow < expires <= nextNow
		while (this.histTimers[0]) {
			// next timeout's timer
			const timer = this.histTimers[0];				// (first) timer: { timeout, interval, expires, cb, ... }
			if (timer.expires > nextNow) {
				break;										// all offline timers processed
			}												// expires <= nextNow

			// debug log
			if (timer.expires < this.histNow) {				// histNow <= expires <= nextNow
				this.logf.error('%-15s %-15s %-10s expires - histNow = %6d <  0 %-18s %s\n%s', this.constructor.name, 'hist_setNow()', 'error',	(timer.expires - this.histNow), '', dateStr(this.histNow), timer.toString());
			} else {
				//this.logf.debug('%-15s %-15s %-10s expires - histNow = %6d >= 0 %-18s %s %s', this.constructor.name, 'hist_setNow()', '',		(timer.expires - this.histNow), '', dateStr(this.histNow), timer.name);
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
				//this.logf.debug('%-15s %-15s %-10s %-50s %s\n%s', this.constructor.name, 'hist_setNow()', 'repeating', 'interval', dateStr(Timer.getNow()), timer2json(histTimer));
			}
		}

		// debug log
		if (this.histNow > nextNow) {						// nextNow - histNow < 0
			this.logf.error('%-15s %-15s %-10s nextNow - histNow < %6d %-20s %s', this.constructor.name, 'hist_setNow()', 'error', (nextNow - this.histNow), '', dateStr(this.histNow));
		} else {
			//this.logf.debug('%-15s %-15s %-10s %-50s %s', this.constructor.name, 'hist_setNow()', 'done', '', dateStr(nextNow));
		}

		this.histNow = nextNow;
	}


	/**
	 *
	 */
	private async hist_convertTimers() {						// convert timers - must be called after update of getNow(), setTimer(), clearTimer()
		this.logf.debug('%-15s %-15s %-20s switching #%d timers from offline to online mode ...', this.constructor.name, 'hist_convertTimers()', '', this.histTimers.length);

		// convert offline timer to online timer
		for (const timer of this.histTimers) {
			this.logf.debug('%-15s %-15s %-20s %-40s\n%s', this.constructor.name, 'hist_convertTimers()', '', 'switching timer from offline to online mode', timer.toString());
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

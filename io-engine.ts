import { IoAdapter, StateChange, ValType, dateStr, valStr }		from './io-adapter';
import { IoSql, SqlHistoryRow, IoWriteCacheVal }				from './io-sql';
import { IoStates, AnyState }		from './io-state';
import { IoOperator }				from './io-operator';
import { Timer, TimerOpts }			from './io-timer';
import { sortBy }					from './util';
import { sprintf }					from 'sprintf-js';


// HistRowSize
const HistRowSize	= 100*1000;


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
		const useHistory = (historyDays > 0) ? await this.sql_connect() : false;

		// create own folder objects
		await this.add_folders();

		// ~~~~~~~
		// HISTORY
		// ~~~~~~~
		if (useHistory) {
			this.logf.debug('%-15s %-15s %-10s %-50s %.1f days', this.constructor.name, 'start()', 'history', '...', historyDays);

			// optimize tables
			if (this.adapter.config['sql-optimize']) {
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

			// set IoState.onWrite()		-		called recursively
			let flushed: Promise<void> | undefined;
			IoStates.write = async (ioState: AnyState, val: ValType): Promise<void> => {
				const ts = this.histNow;
				if (ioState.writable) {
					this.logf.warn('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'write()', 'skipped', ioState.stateId, dateStr(ts), valStr(val));
				} else {
					//if (Date.now() - ts < 1000*60*20)		this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', this.constructor.name, 'write()', 'queued',  ioState.stateId, dateStr(ts), valStr(val));
					const len = this.histWriteCache.push({ 'stateId': ioState.stateId, val, ts });
					if (len >= HistRowSize/2) {
						await flushed;
						flushed = this.sql_flush();
					}
					await ioState.valSet(val, ts);			// will recursively call op.execute() --> IoState.write()
				}
			};
			await flushed;

			// init states, init operators
			await this.hist_init({ fromTs });
			await IoOperator.opInit();

			// process history
			await this.hist_exec({ fromTs });
			await this.setNow(Date.now());		// process pending OFFLINE timers

			await this.sql_flush();				// write   pending ONLINE  samples

			// close db connection
			await this.sql.onUnload();


		// don't use history
		} else {
			this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'start()', 'online', '...');

			// init states
			for (const ioState of Object.values(IoStates.allStates)) {
				const stateId	= ioState.stateId;
				const state		= await this.adapter.readState(stateId);
				if (state  &&  state.val !== null) {
					ioState.valInit({
						'val':	state.val,
						'ts':	state.ts
					});
				}
			}

			// init operators
			await IoOperator.opInit();
		}

		// ~~~~~
		// START
		// ~~~~~

		// init Timer
		Timer.init();
		await this.convertTimers();			// convert pending offline timers

		// IoState.write()
		IoStates.write = async (ioState: AnyState, val: ValType): Promise<void> => {
			const ts  =  Date.now();
			const ack = ! ioState.writable;
			if (ioState.logType === 'write') {
				this.logf.debug('%-15s %-15s %-10s %-50s %s   %s%s', ioState.constructor.name, 'write()', '', ioState.stateId, dateStr(ts), valStr(val), ack ? '' : ' cmd');
			}
			await this.adapter.writeState(ioState.stateId, { val, ack, ts });				// will call subscribed ack change handler
		};

		// update iobroker state val
		for (const stateId of Object.keys(IoStates.allStates).sort()) {
			const ioState = IoStates.allStates[stateId];
			if (useHistory  &&  ioState?.writable === false  &&  ioState.outputFrom.length > 0) {
				const state = await this.adapter.readState(ioState.stateId);
				if (state?.val !== ioState.val) {
					this.logf.debug('%-15s %-15s %-10s %-50s %s   %s', ioState.constructor.name, 'start()', 'changed', ioState.stateId, dateStr(Timer.now()), valStr(ioState.val));
					await this.adapter.writeState(ioState.stateId, { 'val': ioState.val, 'ack': true });
				}
			}
		}

		// subscribe iobroker state ack for all operator input states
		for (const stateId of Object.keys(IoStates.allStates).sort()) {
			const ioState = IoStates.allStates[stateId];
			if (ioState) {
				// subscribe iobroker state changes
				await this.adapter.subscribe({ stateId, 'ack': true, 'cb': async (stateChange: StateChange) => {
					if (ioState.logType === 'changed'  &&  stateChange.val !== ioState.val) {
						this.logf.debug('%-15s %-15s %-10s %-50s %s   %s%s', ioState.constructor.name, 'onChange()', ((stateChange.val === ioState.val) ? 'unchanged' : ''), stateId, dateStr(stateChange.ts), valStr(stateChange.val), stateChange.ack ? '' : ' cmd');
					}
					await ioState.valSet(stateChange.val, stateChange.ts);		// will recursively call op.execute() --> IoState.write()
				}});
			}
		}

		// started
		IoOperator.setStarted();
		this.logf.debug('%-15s %-15s %-10s %-50s', this.constructor.name, 'start()', '', 'started');
	}

	/**
	 *
	 * @param fromTs
	 * @returns
	 */
	private async hist_init({ fromTs }: { fromTs: number }): Promise<void> {
		this.logf.debug('%-15s %-15s %-10s', this.constructor.name, 'hist_init()', '');

		// allStates
		const allStates = Object.values(IoStates.allStates).sort(sortBy('stateId'));
		//this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_init()', 'allStates', JSON.stringify(allStates, null, 4));

		// init histSrc and histDst states
		for (const ioState of allStates) {
			const stateId = ioState.stateId;
			const rows = await this.sql.readHistory([ stateId ], {			// [ { id, ts, val, ack, bool } ]
				'until': fromTs, 'ack': true, 'desc': true, 'limit': 1
			});
			if (rows[0]) {
				ioState.valInit({ 'val': rows[0].val, 'ts': rows[0].ts });
			} else {
				const state = await this.adapter.readState(stateId);
				if (state  &&  state.val !== null) {
					ioState.valInit({ 'val': state.val, 'ts': fromTs });
				}
			}
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
			const isHistDst = (!state.writable )  &&    isOutput;		// state is read only     output
			if (isHistSrc)  					{ srcStates[state.stateId] = state; }
			if (isHistDst)  					{ dstStates[state.stateId] = state; }
			if (! isHistSrc  &&  ! isHistDst)	{ skipped  [state.stateId] = state; }
		}
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_exec()', 'skipped',   JSON.stringify(Object.keys(skipped  ).sort(), null, 4));
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_exec()', 'srcStates', JSON.stringify(Object.keys(srcStates).sort(), null, 4));
		this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'hist_exec()', 'dstStates', JSON.stringify(Object.keys(dstStates).sort(), null, 4));

		// srcStateIds, dstStateIds
		const srcStateIds = Object.keys(srcStates).sort();
		const dstStateIds = Object.keys(dstStates).sort();

		// delete history of all histDst states
		this.logf.debug('%-15s %-15s %-10s %-50s %s', this.constructor.name, 'hist_exec()', 'fromTs', 'deleting history from...', dateStr(fromTs));
		let now = Date.now();
		const affectedRows = await this.sql.delHistory(dstStateIds, {
			'from':		fromTs
		});
		this.logf.debug('%-15s %-15s %-10s %-50s %s   (%4.1f s)', this.constructor.name, 'hist_exec()', 'deleted', `#${String(affectedRows['ts_number'] ?? 0)} ts_number, #${String(affectedRows['ts_bool'] ?? 0)} ts_bool`, dateStr(now), (Date.now() - now)/1000);

		// processHist(srcRows), processed
		const processHist = async (srcRows: SqlHistoryRow[]): Promise<void> => {
			for (const row of srcRows) {
				if		(row.ts < this.histNow)  { this.logf.error('%-15s %-15s %-10s %-50s %s < %s', this.constructor.name, 'hist_exec()', 'row', row.id, dateStr(row.ts), dateStr(row.ts)); throw new Error(''); }
				else if (row.ts > this.histNow)  { await this.setNow(row.ts); }

				// process srcState
				const state = srcStates[row.id];
				if (state) {
					await state.valSet(row.val, row.ts);		// will recursively call op.execute() --> IoState.write()
				}
			}
		};

		// process tsChunks
		now = Date.now();
		const tsChunks = await this.sql.ts_chunks(srcStateIds, HistRowSize, { 'from': fromTs });
		this.logf.debug('%-15s %-15s %-10s %-50s %s   (%4.1f s)', this.constructor.name, 'hist_exec()', 'tsChunks', `#${String(tsChunks.length)}`, dateStr(now), (Date.now() - now)/1000);

		for (;;) {
			// read acknowledged history of all srcStates
			now = Date.now();
			const beforeTs = tsChunks.shift();
			const srcRows = await this.sql.readHistory(srcStateIds, {
				'from':			fromTs,
				'before':		beforeTs,
				'ack':			true,
				'isNull':		false,
			});
			this.logf.debug('%-15s %-15s %-10s %-36s %8s %s   (%4.1f s)', this.constructor.name, 'hist_exec()', 'got', sprintf('%6d rows from %s', srcRows.length, dateStr(fromTs)), 'before', dateStr(beforeTs), (Date.now() - now)/1000);

			// process history
			await processHist(srcRows);

			if (beforeTs === undefined)	break;
			else						fromTs = beforeTs;
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
				this.logf.error('%-15s %-15s %-10s expires - histNow = %6d <  0 %-13s %s\n%s', this.constructor.name, 'setNow()', 'error', (timer.expires - this.histNow), '', dateStr(this.histNow), timer.toString());
			}

			// set histNow, process timer timeout
			this.histNow = timer.expires;					// histNow := expires <= nextNow
			await timer.cb();

			// update expires or delete timer
			if (timer.timeout !== null)		{
				timer.timeout   = null;
			}
			if (timer.interval !== null) {
				timer.expires  +=  timer.interval;
				//this.logf.debug('%-15s %-15s %-10s %-50s %s\n%s', this.constructor.name, 'setTimer()', 'repeating', 'interval', dateStr(Timer.getNow()), timer2json(histTimer));
				this.histTimers.sort(sortBy('expires'));
			} else {
				this.histTimers.shift();
			}
		}

		// debug log
		if (this.histNow > nextNow) {						// nextNow - histNow < 0
			this.logf.error('%-15s %-15s %-10s nextNow - histNow < %6d %-20s %s', this.constructor.name, 'setNow()', 'error', (nextNow - this.histNow), '', dateStr(this.histNow));
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
				if (timeout <= 0)	{	await this.adapter.runExclusive(() => cb());	}
				else				{	Timer.setTimer({ name, timeout,  cb });			}

			// interval
			} else {
				if (timeout <= 0)	{	await this.adapter.runExclusive(() => cb());
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
	public async sql_flush(): Promise<void> {
		if (this.histWriteCache.length > 0) {
			const now   = Date.now();
			const until = this.histWriteCache.slice(-1)[0]?.ts  ??  now;
			const history = this.histWriteCache.splice(0, this.histWriteCache.length);
			const affectedRows = await this.sql.writeHistory(history);
			this.logf.debug('%-15s %-15s %-10s %-36s %8s %s   (%4.1f s)', this.constructor.name, 'sql_flush()', 'written', sprintf('%6d ts_number, %6d ts_bool', affectedRows['ts_number'] ?? 0, affectedRows['ts_bool'] ?? 0), 'until', dateStr(until), (Date.now() - now)/1000);
		}
	}

	/**
	 *
	 */
	private async add_folders() {
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
};

import { IoAdapter, ValType }		from './io-adapter';
import mysql 						from 'mysql2/promise';
// based on https://sidorares.github.io/node-mysql2/docs/examples/typescript/basic-custom-class

// SqlConnOpts, SqlConn
type SqlConnOpts	= mysql.ConnectionOptions;
type SqlConn		= mysql.Connection;

// IoWriteCacheVal
export interface IoWriteCacheVal {
	stateId:		string,
	val:			ValType,
	ts:				number,
}

// SqlQueryOpts
export interface SqlQueryOpts {
	ack?:			boolean,
	isNull?:		boolean,
	at?:			number,
	after?:			number,
	from?:			number,
	before?:		number,
	until?:			number,
	desc?:			boolean,
	limit?:			number,
}

// SqlHistoryRow		-		sql history response
export interface SqlHistoryRow {
	id:			string,
	ts:			number,
	val:		number | string | boolean,
	t:			'n'    | 's'    | 'b',
}

// SqlTables
type  TableNames = 'ts_number' | 'ts_string' | 'ts_bool';
const TableName: TableNames[] = [ 'ts_number', 'ts_string', 'ts_bool' ];		// by sql datapoint type 0, 1, 2

// TableName, Datapoint, Datapoints
interface Datapoint { tblName: TableNames, id: number }
type Datapoints = Record<string, Datapoint>;		// by stateId


// ~~~~~
// IoSql
// ~~~~~
export class IoSql {
	private readonly	logf									= IoAdapter.logf;
	private 			datapoints: 	Datapoints				= {};			// by stateId
	private				timer?:			NodeJS.Timeout;
	private				sqlConn?:		SqlConn;

	/**
	 *
	 * @param opts
	 * @returns
	 */
	private conn(): SqlConn {
		if (this.sqlConn === undefined) {
			throw new Error(`${this.constructor.name}: conn(): connection not established`);
		}
		return this.sqlConn;
	}

	/**
	 *
	 * @param opts
	 * @returns
	 */
	public async connect(sqlConnOpts: SqlConnOpts): Promise<boolean> {
		try {
			this.logf.debug('%-15s %-15s', this.constructor.name, 'init()');
			this.sqlConn = await mysql.createConnection(sqlConnOpts);
			await this.loadDatapoints();
			//this.logf.debug('%-15s %-15s %-10s\n%s', this.constructor.name, 'init()', 'datapoints', JSON.stringify(this.datapoints, null, 4));
			return true;

		} catch (e: unknown) {
			this.logf.error('%-15s %-15s %-10s\n%s', this.constructor.name, 'init()', 'error', JSON.stringify(e, null, 4));
			return false;
		}
	}

	/**
	 *
	 */
	public async onUnload(): Promise<void> {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
		}
		await this.conn().end();
	}

	/**
	 *
	 * @param stateIds
	 * @param queryOpts
	 * @returns
	 */
	public async readHistory(stateIds: string[], queryOpts: SqlQueryOpts): Promise<SqlHistoryRow[]> {
		await this.waitCache();

		const and_cond	= this.query_and_cond(queryOpts);
		const order_by	= (queryOpts.desc ) ? 'ts DESC'								: 'ts ASC';
		const LIMIT		= (queryOpts.limit) ? `LIMIT ${String(queryOpts.limit)}`	: '';

		const tblSelects = [];
		const datapoints = this.getDatapoints(stateIds);					// { ts_number: [ dpId, dpId, ...],  ... }
		for (const [ table, dpIds ] of Object.entries(datapoints)) {		// table: 'ts_number', 'ts_string', 'ts_bool' --> t: 'n' | 's' | 'b'
			tblSelects.push(`(
				SELECT		name as id, ts, val, '${String(table[3])}' AS t
				FROM		iobroker.${table} LEFT JOIN iobroker.datapoints USING(id)
				WHERE		id IN(${dpIds.join(',')}) ${and_cond}
				ORDER BY	${order_by}
				${LIMIT}
			)`);
		}

		if (tblSelects.length === 0) {
			return [];
		}

		// get rows
		const qryStr = tblSelects.join(' UNION ALL ') + ` ORDER BY ${order_by} ${LIMIT}`;

		interface HistoryRow extends mysql.RowDataPacket, SqlHistoryRow {}
		const [ rows ] = await this.conn().query<HistoryRow[]>(qryStr);
		//this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'readHistory()', 'rows', '', JSON.stringify(rows, null, 4));

		rows.forEach((row) => {
			if		(row.t === 'b')		{ row.val = (row.val === 1);	}			// boolean
			else if (row.t === 'n')		{ /* empty */					}			// number
			else						{ /* empty */					}			// string
		});
		//this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'readHistory()', 'rows', '', JSON.stringify(rows, null, 4));
		//this.logf.debug('%-15s %-15s %-10s %-50s got #%d rows', this.constructor.name, 'readHistory()', 'rows', '', rows.length);

		return rows;
	}

	/**
	 *
	 * @param samples
	 */
	public async writeHistory(samples: IoWriteCacheVal[]): Promise<Record<string, number>> {
		await this.waitCache();

		// tblValues
		const tblValues: Record<string, string[]> = {
			'ts_number':	[],
			'ts_bool':		[],
		};

		// convert samples to inserts
		for (const sample of samples) {
			const dp = this.datapoints[sample.stateId];
			if (dp) {		//  ( id, ts, val, ack,_from,q)
				const values = tblValues[dp.tblName];
				if (values) {
					values.push(`(${String(dp.id)},${String(sample.ts)},${String(sample.val)},TRUE,NULL,0)`);
				}
			}
		}

		// SQL INSERT values into table
		const affectedRows: Record<string, number> = {};			// by tblName
		for (const [ tblName, values ] of Object.entries(tblValues)) {
			if (values.length > 0) {
				const qryStr = `
					INSERT
					INTO		iobroker.${tblName} (id,ts,val,ack,_from,q)
					VALUES		${values.join(',')}
					ON DUPLICATE KEY UPDATE val=val, ack=ack
				`;
				const [ result ] = await this.conn().query<mysql.ResultSetHeader>(qryStr);
				//this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'writeHistory()', 'result', '', JSON.stringify( result, null, 4));
				affectedRows[tblName] = result.affectedRows;
			}
		}

		return affectedRows;
	}

	/**
	 *
	 * @param stateIds
	 * @param queryOpts
	 * @returns
	 */
	public async delHistory(stateIds: string[], queryOpts: SqlQueryOpts): Promise<Record<string, number>> {
		await this.waitCache();

		const dpIds = stateIds.map(stateId => this.datapoints[stateId]?.id).filter(dpId => (dpId !== undefined));
		const affectedRows: Record<string, number> = {};		// by tblName

		if (dpIds.length === 0) {
			this.logf.warn('%-15s %-15s %-10s %-50s', this.constructor.name, 'delHistory()', 'dpIds', 'empty');

		} else {
			const datapoints = this.getDatapoints(stateIds);					// { tblName: [ dpId, dpId, ...],  ... }
			for (const [ tblName, dpIds ] of Object.entries(datapoints)) {		// val AS 'val_number', 'val_string', 'val_bool'
				const and_cond = this.query_and_cond(queryOpts);
				const qryStr = `
					DELETE
					FROM		iobroker.${tblName}
					WHERE		id IN(${dpIds.join(',')}) ${and_cond}
				`;
				const [ result ] = await this.conn().query<mysql.ResultSetHeader>(qryStr);
				//this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'delHistory()', 'result', '', JSON.stringify( result, null, 4));
				affectedRows[tblName] = result.affectedRows;
			}
		}

		return affectedRows;
	}

	// ~~~~~~~~~~~~~~~~~~~~~
	// optimizeTablesAsync()
	// ~~~~~~~~~~~~~~~~~~~~~
	public async optimizeTablesAsync() {
		const tables = TableName.map(tableName => `iobroker.${tableName}`).join(', ');
		this.logf.debug('%-15s %-15s %-10s %s', this.constructor.name, 'optimizeTablesAsync()', '.....', `optimizing ${tables}`);

		const [ result ] = await this.conn().query(`OPTIMIZE TABLE ${tables} WAIT 120`);
		this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'optimizeTablesAsync()', 'result', '', JSON.stringify( result, null, 4));

		this.logf.debug('%-15s %-15s %-10s', this.constructor.name, 'optimizeTablesAsync()', 'done.');
	}


	// ~~~~~~~~~~~~~~~~
	// cleanUpHistory()
	// ~~~~~~~~~~~~~~~~
	async cleanUpHistory() {
		const adapter	= IoAdapter.this;
		const historyId	= adapter.historyId;

		// get all stateObjs with enabled changesOnly
		const stateObjs = Object.values(await adapter.getForeignObjectsAsync('*', 'state')).filter(stateObj => {
			const custom  = (stateObj.common.custom ?? {})	as Record<string, Record<string, unknown> | undefined>;
			const history = custom[historyId];
			return (typeof history === 'object')  &&  history['enabled']  &&  history['changesOnly'];
		});
		this.logf.info('%-15s %-25s %-45s processing %d stateObjs ...', this.constructor.name, 'cleanUpHistory()', historyId, stateObjs.length);

		// cleanup iobroker datapoints
		for (const stateObj of stateObjs) {
			const  stateId = stateObj._id;
			this.logf.info('%-15s %-25s %-45s %s', this.constructor.name, 'cleanUpHistory()', stateId, historyId);

			/* FIXME
			const dp = this._datapoints[stateId];				// { table, id }
			if (! dp) {
				this.logf.warn('%-15s %-25s %-45s missing datapoint', this.constructor.name, 'cleanUpHistory()', stateId);
				const stateChange = await adapter.getForeignStateAsync(stateId);
				await adapter.setForeignStateAsync(stateId, stateChange.val, stateChange.ack);

			} else {
				// get/set changesRelogInterval
				const changesRelogSecs = parseInt(stateObj.common.custom[historyId].changesRelogInterval)  ||  3600*24;		// 1 day
				if (changesRelogSecs !==          stateObj.common.custom[historyId].changesRelogInterval) {
					stateObj.common.custom[historyId].changesRelogInterval = changesRelogSecs;
					await adapter.setForeignObjectAsync(stateId, stateObj);
				}

				// get unchanged datapoints
				const unchanged = await this.queryAsync(`
					WITH cte AS (
						SELECT ts, val, ack,
							LAG(ts ) OVER (ORDER BY ts) AS prev_ts,
							LAG(val) OVER (ORDER BY ts) AS prev_val,
							LAG(ack) OVER (ORDER BY ts) AS prev_ack
						FROM  iobroker.${dp.table}
						WHERE id=${dp.id}
					)
					SELECT ts, val, ack FROM cte WHERE (val = prev_val) AND (ack = prev_ack) AND (ts - prev_ts < ${changesRelogSecs*1000})
				`);
				if (unchanged.length === 0) {
					this.logf.debug('%-15s %-25s %-45s', this.constructor.name, 'cleanUpHistory()', stateId);

				} else {
					if (unchanged.length > 0) {
						this.logf.debug('%-15s %-25s %-45s deleting %d rows', this.constructor.name, 'cleanUpHistory()', stateId, unchanged.length);
					}
					for (const row of unchanged) {
						this.logf.debug('%-15s %-25s %-45s %s  %s %s', this.constructor.name, 'cleanUpHistory()', stateId, ts_string(row.ts), val_string(row.val), (row.ack ? 'ack' : 'cmd'));
					}

					// delete unchanged datapoints
					await this.queryAsync(`
						DELETE FROM	iobroker.${dp.table}
						WHERE		id=${dp.id} AND ts IN(${unchanged.map(row => row.ts).join(',')})
					`);
					//this.logf.info('%-15s %-25s %-45s %3d datapoints deleted', this.constructor.name, 'cleanUpHistory()', stateId, res.affectedRows));
					//this.logf.info('%-15s %-25s %-45s %s', this.constructor.name, 'cleanUpHistory()', stateId, JSON.stringify(stateObj, null, 4)));
				}
			}
			*/
		}
		this.logf.info('%-15s %-25s %-45s processing %d stateObjs done', this.constructor.name, 'cleanUpHistory()', historyId, stateObjs.length);
	}

	/**
	 *
	 */
	private async loadDatapoints() {
		interface Datapoint extends mysql.RowDataPacket {
			name:	string,
			id:		number,
			type:	number,
		}
		const qryStr = 'SELECT name, id, type from iobroker.datapoints ORDER BY name';
		const [ rows ] = await this.conn().query<Datapoint[]>(qryStr);
		//this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'loadDatapoints()', 'rows',   '', JSON.stringify( rows,   null, 4));

		for (const row of rows) {						// row: { name: string, id: number, type: number }
			const stateId	= row.name;
			const dpId		= row.id;
			const dpTypeNb	= row.type;					// 0, 1, 2
			const tblName	= TableName[dpTypeNb];		//
			if (typeof tblName === 'string') {
				this.datapoints[stateId] = {
					'tblName':		tblName,
					'id':			dpId,
				};
			}
		}
	}

	//
	public stateIds(): string[] {
		return Object.keys(this.datapoints);
	}

	/**
	 *
	 * @param stateIds
	 * @returns
	 */
	private getDatapoints(stateIds: string[]) {
		const dpTables: Record<string, number[]> = {};		// { tblName: [ dpId, dpId, ...],  ... }
		for (const stateId of stateIds) {
			const dp = this.datapoints[stateId];
			if (dp) {
				const dpArr = dpTables[dp.tblName] = dpTables[dp.tblName]  ??  [];
				dpArr.push(dp.id);
			}
		}
		return dpTables;
	}

	/**
	 *
	 * @param queryOpts
	 * @returns
	 */
	private query_and_cond(queryOpts: SqlQueryOpts) {
		let ts_cond = '';
		if (queryOpts.at		!== undefined)		{ ts_cond += ` AND ts =   ${String(queryOpts.at    )}`;					}
		if (queryOpts.before	!== undefined)		{ ts_cond += ` AND ts <   ${String(queryOpts.before)}`;					}
		if (queryOpts.after		!== undefined)		{ ts_cond += ` AND ts >   ${String(queryOpts.after )}`;					}
		if (queryOpts.from		!== undefined)		{ ts_cond += ` AND ts >=  ${String(queryOpts.from  )}`;					}
		if (queryOpts.until		!== undefined)		{ ts_cond += ` AND ts <=  ${String(queryOpts.until )}`;					}
		if (queryOpts.ack		!== undefined)		{ ts_cond += ` AND ack =  ${String(queryOpts.ack   )}`;					}
		if (queryOpts.isNull	!== undefined)		{ ts_cond += ` AND val IS ${queryOpts.isNull ? 'NULL' : 'NOT NULL'}`;	}
		return ts_cond;
	}


	/**
	 *
	 * @param maxLevel
	 */
	public async waitCache(maxLevel = 0): Promise<void> {
		const WaitMs = 250;
		let cacheLevel: number;
		let cacheWait = false;
		do {
			cacheLevel = await this.cacheLevel();
			if (cacheLevel > maxLevel) {
				this.logf.warn('%-15s %-15s %-10s %4.1f %% >  %4.1f %%; retrying in %d ms ...', this.constructor.name, 'waitCache()', 'cacheLevel', cacheLevel*100, maxLevel*100, WaitMs);
				cacheWait = true;
				await new Promise((res, _rej) => {				// wait
					this.timer = setTimeout(res, WaitMs);		// WaitMs
				});
			}
		} while (cacheLevel > maxLevel);

		if (cacheWait) {
			this.logf.warn('%-15s %-15s %-10s %4.1f %% <= %4.1f %%; done', this.constructor.name, 'waitCache()', 'cacheLevel', cacheLevel*100, maxLevel*100);
		}
	}


	/**
	 *
	 * @returns
	 */
	private async cacheLevel(): Promise<number> {
		let cache_level = 0;

		// get Aria storage engine status variables
		//FIXME 'bigIntAsNumber':	true
		const qryStr = `SHOW STATUS LIKE 'Aria_pagecache_blocks_%';`;
		type CacheStatusVar = 'Aria_pagecache_blocks_not_flushed' | 'Aria_pagecache_blocks_unused' | 'Aria_pagecache_blocks_used';
		interface CacheStatusRow extends mysql.RowDataPacket {
			Variable_name:		CacheStatusVar,
			Value:				string,
		}
		const [ result ] = await this.conn().query<CacheStatusRow[]>(qryStr);
		//this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'cacheLevel()', 'result', '', JSON.stringify( result, null, 4));

		// cacheBlocks
		const status = result.reduce((obj, row) => {
			obj[row.Variable_name] = parseInt(row.Value);
			return obj;
		}, {} as Record<CacheStatusVar, number>);
		//this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'cacheLevel()', 'status', '', JSON.stringify(status, null, 4));

		cache_level = status.Aria_pagecache_blocks_not_flushed / (status.Aria_pagecache_blocks_used + status.Aria_pagecache_blocks_unused);
		//this.logf.debug('%-15s %-15s %-10s %-50s %4.1f %%', this.constructor.name, 'cacheLevel()', 'level', '', cache_level*100);

		return cache_level;
	}
}

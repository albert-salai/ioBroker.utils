import { IoAdapter, ValType }		from './io-adapter';
import MySql 						from 'mysql2/promise';
// based on https://sidorares.github.io/node-mysql2/docs/examples/typescript/basic-custom-class

// IoWriteCacheVal
export interface IoWriteCacheVal {
	stateId:		string,
	val:			ValType,
	ts:				number,
};

// SqlConnOpts
export type SqlConnOpts = MySql.PoolOptions;

// SqlQueryOpts
export interface SqlQueryOpts {
	desc?:			boolean,
	at?:			number,
	limit?:			number,
	before?:		number | undefined,
	after?:			number,
	from?:			number,
	until?:			number,
	ack?:			boolean,
	isNull?:		boolean
}

// SqlHistoryRow		-		sql history response
export interface SqlHistoryRow {
	id:			string,
	ts:			number,
	val:		number | string | boolean,
	t:			'n'    | 's'    | 'b',
};

// TblName
const TblName = [ 'ts_number', 'ts_string', 'ts_bool' ];				// by sql datapoint type 0, 1, 2

// Datapoints
type Datapoints = Record<string, { tblName: string, id: number }>;		// by stateId



// ~~~~~
// IoSql
// ~~~~~
export class IoSql {
	private readonly	logf									= IoAdapter.logf;
	private 			datapoints: 	Datapoints				= {};			// by stateId
	private				timer?:			NodeJS.Timeout;
	private				sqlConn?:		MySql.Pool;

	/**
	 *
	 * @param opts
	 * @returns
	 */
	private conn(): MySql.Pool {
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
			this.sqlConn = MySql.createPool(sqlConnOpts);
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
	public async ts_chunks(stateIds: string[], modulo: number, queryOpts: SqlQueryOpts): Promise<number[]> {
		const and_cond	= this.query_and_cond(queryOpts);
		const datapoints = this.getDatapoints(stateIds);		// { ts_number: [ dpId, dpId, ...],  ... }
		const dpIds	= datapoints['ts_number'];
		if (! dpIds  ||  dpIds.length === 0) {
			return [];
		}

		const qryStr = `
			WITH cte AS (
				SELECT		ts, ROW_NUMBER() OVER (ORDER BY ts) as rowNum
				FROM		iobroker.ts_number
				WHERE		id IN(${dpIds.join(',')}) ${and_cond}
				ORDER BY	ts
			)
			SELECT ts FROM cte WHERE MOD(rowNum, ${String(modulo)}) = 0 ORDER BY TS
		`;

		// get rows
		interface TsChunk extends MySql.RowDataPacket { ts: number };
		const [ rows ] = await this.conn().query<TsChunk[]>(qryStr);
		const timestamps = rows.map(row => row.ts);

		//this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'ts_chunks()', 'rows', '', JSON.stringify(timestamps, null, 4));
		return timestamps;
	}

	/**
	 *
	 * @param stateIds
	 * @param queryOpts
	 * @returns
	 */
	public async readHistory(stateIds: string[], queryOpts: SqlQueryOpts): Promise<SqlHistoryRow[]> {
		await this.waitCache(0);

		const and_cond	= this.query_and_cond(queryOpts);
		const order_by	= (queryOpts.desc ) ? 'ts DESC'						: 'ts ASC';
		const LIMIT		= (queryOpts.limit) ? `LIMIT ${String(queryOpts.limit)}`	: '';

		const selects = [];
		const datapoints = this.getDatapoints(stateIds);					// { ts_number: [ dpId, dpId, ...],  ... }
		for (const [ table, dpIds ] of Object.entries(datapoints)) {		// table: 'ts_number', 'ts_string', 'ts_bool' --> t: 'n' | 's' | 'b'
			selects.push(`(
				SELECT		name as id, ts, val, '${String(table[3])}' AS t
				FROM		iobroker.${table} LEFT JOIN iobroker.datapoints USING(id)
				WHERE		id IN(${dpIds.join(',')}) ${and_cond}
				ORDER BY	${order_by}
				${LIMIT}
			)`);
		}

		if (selects.length === 0) {
			return [];
		}

		// get rows
		const qryStr  = selects.join(' UNION ALL ') + ` ORDER BY ${order_by} ${LIMIT}`;

		interface HistoryRow extends MySql.RowDataPacket, SqlHistoryRow {};
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
	 * @param stateIds
	 * @param queryOpts
	 * @returns
	 */
	public async delHistory(stateIds: string[], queryOpts: SqlQueryOpts): Promise<Record<string, number>> {
		await this.waitCache(0);

		const dpIds = stateIds.map(stateId => this.datapoints[stateId]?.id).filter(dpId => (dpId !== undefined));
		const affectedRows: Record<string, number> = {};		// by tblName

		if (dpIds.length === 0) {
			this.logf.warn('%-15s %-15s %-10s %-50s', this.constructor.name, 'delHistory()', 'dpIds', 'empty');

		} else {
			const datapoints = this.getDatapoints(stateIds);					// { tblName: [ dpId, dpId, ...],  ... }
			for (const [ tblName, dpIds ] of Object.entries(datapoints)) {		// val AS 'val_number', 'val_string', 'val_bool'
				const and_cond = this.query_and_cond(queryOpts);
				const qryStr = `DELETE FROM iobroker.${tblName} WHERE id IN(${dpIds.join(',')}) ${and_cond}`;
				const [ result ] = await this.conn().query<MySql.ResultSetHeader>(qryStr);
				//this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'delHistory()', 'result', '', JSON.stringify( result, null, 4));
				affectedRows[tblName] = result.affectedRows;
			}
		}

		return affectedRows;
	}

	/**
	 *
	 * @param samples
	 */
	public async writeHistory(samples: IoWriteCacheVal[]): Promise<Record<string, number>> {
		await this.waitCache(0);

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
				const qryStr = `INSERT INTO iobroker.${tblName} (id,ts,val,ack,_from,q) VALUES ${values.join(',')} ON DUPLICATE KEY UPDATE val=val, ack=ack`;
				const [ result ] = await this.conn().query<MySql.ResultSetHeader>(qryStr);
				//this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'writeHistory()', 'result', '', JSON.stringify( result, null, 4));
				affectedRows[tblName] = result.affectedRows;
			}
		}

		return affectedRows;
	}

	/**
	 *
	 */
	private async loadDatapoints() {
		const qryStr = 'SELECT name, id, type from iobroker.datapoints ORDER BY name';
		interface Datapoint extends MySql.RowDataPacket {
			name:	string,
			id:		number,
			type:	number,
		};
		const [ rows ] = await this.conn().query<Datapoint[]>(qryStr);
		//this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'loadDatapoints()', 'rows',   '', JSON.stringify( rows,   null, 4));

		for (const row of rows) {					// row: { name: string, id: number, type: number }
			const stateId	= row.name;
			const dpId		= row.id;
			const dpTypeNb	= row.type;				// 0, 1, 2
			const tblName	= TblName[dpTypeNb];	//
			if (typeof tblName === 'string') {
				this.datapoints[stateId] = {
					'tblName':		tblName,
					'id':			dpId,
				};
			}
		}
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

	// ~~~~~~~~~~~~~~~~~~~~~
	// optimizeTablesAsync()
	// ~~~~~~~~~~~~~~~~~~~~~
	public async optimizeTablesAsync() {
		const tables = TblName.map(tableName => `iobroker.${tableName}`).join(', ');
		this.logf.debug('%-15s %-15s %-10s %s', this.constructor.name, 'optimizeTablesAsync()', '.....', `optimizing ${tables}`);

		const [ result ] = await this.conn().query(`OPTIMIZE TABLE ${tables} WAIT 120`);
		this.logf.debug('%-15s %-15s %-10s %-50s\n%s', this.constructor.name, 'optimizeTablesAsync()', 'result', '', JSON.stringify( result, null, 4));

		this.logf.debug('%-15s %-15s %-10s', this.constructor.name, 'optimizeTablesAsync()', 'done.');
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
	private async waitCache(maxLevel: number): Promise<void> {
		let cacheLevel: number;
		let cacheWait = false;
		do {
			cacheLevel = await this.cacheLevel();
			if (cacheLevel > maxLevel) {
				this.logf.warn('%-15s %-15s %-10s %4.1f %% >  %4.1f %%; retrying in 1s ...', this.constructor.name, 'waitCache()', 'cacheLevel', cacheLevel*100, maxLevel*100);
				cacheWait = true;
				await new Promise((res, _rej) => {				// wait
					this.timer = setTimeout(res, 1000);			// 1 s
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
		interface CacheStatusRow extends MySql.RowDataPacket {
			Variable_name:		CacheStatusVar,
			Value:				string,
		};
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
};

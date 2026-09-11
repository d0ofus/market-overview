import { describe, expect, it } from "vitest";
import { canonicalStorageRows,createStoragePriceYearReader,storageRowKey,storageTable,type StorageRow } from "../src/market-storage-pages";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("bounded source year streaming",()=>{
  it("crosses250-row pages without dropping years and resumes after the last verified composite key",async()=>{
    const source=createSqliteD1(),table=storageTable("alpaca_daily_bars");
    try {
      source.script(table.sql+";");
      const dates=[2024,2025].flatMap(year=>Array.from({length:260},(_,index)=>new Date(Date.UTC(year,0,index+1)).toISOString().slice(0,10)));
      const rows=[...dates.map(date=>({ticker:"AAA",date})),{ticker:"AAA",date:"2026-01-02"},{ticker:"BBB",date:"2026-01-02"}];
      await source.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c)
        SELECT 'sip',json_extract(value,'$.ticker'),json_extract(value,'$.date'),10,10,10,10 FROM json_each(?)`).bind(JSON.stringify(rows)).run();
      let requests=0;
      const counted={...source.db,prepare:(sql:string)=>{
        expect(sql).toContain("LIMIT 250");
        const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){
          if(key==="bind")return (...params:unknown[])=>wrap(target.bind(...params));
          if(key==="all")return async()=>{requests++;return target.all();};
          const value:unknown=Reflect.get(target,key);return typeof value==="function" ? value.bind(target) : value;
        }});
        return wrap(source.db.prepare(sql));
      }} as D1Database;
      const reader=createStoragePriceYearReader(counted,null);
      const first=await reader(1);
      expect(first.groups.map(group=>group.length)).toEqual([260]);
      expect(first.next).toMatchObject({ticker:"AAA",date:"2025-01-01"});
      expect(requests).toBe(2);
      const last=await reader();
      expect(last.groups.map(group=>group.length)).toEqual([260,1,1]);expect(last.next).toBeUndefined();
      expect(requests).toBe(3);
      const all=(await source.db.prepare("SELECT * FROM alpaca_daily_bars ORDER BY feed,ticker,date").all<StorageRow>()).results;
      expect(canonicalStorageRows(table,[...first.groups,...last.groups].flat())).toBe(canonicalStorageRows(table,all));
      const resumed=await createStoragePriceYearReader(source.db,storageRowKey(table,first.groups[0].at(-1)!))();
      expect(resumed.groups).toEqual(last.groups);expect(resumed.next).toBeUndefined();
    } finally {source.dispose();}
  });
});

import { describe, expect, it } from "vitest";
import { canonicalStorageRows,createStoragePriceYearReader,storageRowKey,storageTable,type StorageRow } from "../src/market-storage-pages";
import { createSqliteD1 } from "./helpers/sqlite-d1";

describe("bounded source year streaming",()=>{
  it("crosses 1000-row pages without dropping years and resumes after the last verified composite key",async()=>{
    const source=createSqliteD1(),table=storageTable("alpaca_daily_bars");
    try {
      source.script(table.sql+";");
      const dates=[2022,2023,2024,2025].flatMap(year=>Array.from({length:260},(_,index)=>new Date(Date.UTC(year,0,index+1)).toISOString().slice(0,10)));
      const rows=[...dates.map(date=>({ticker:"AAA",date})),{ticker:"AAA",date:"2026-01-02"},{ticker:"BBB",date:"2026-01-02"}];
      await source.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c)
        SELECT 'sip',json_extract(value,'$.ticker'),json_extract(value,'$.date'),10,10,10,10 FROM json_each(?)`).bind(JSON.stringify(rows)).run();
      let requests=0;
      const counted={...source.db,prepare:(sql:string)=>{
        expect(sql).toContain("LIMIT 1000");
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
      expect(first.next).toMatchObject({ticker:"AAA",date:"2023-01-01"});
      expect(requests).toBe(1);
      const last=await reader();
      expect(last.groups.map(group=>group.length)).toEqual([260,260,260,1,1]);expect(last.next).toBeUndefined();
      expect(requests).toBe(2);
      const all=(await source.db.prepare("SELECT * FROM alpaca_daily_bars ORDER BY feed,ticker,date").all<StorageRow>()).results;
      expect(canonicalStorageRows(table,[...first.groups,...last.groups].flat())).toBe(canonicalStorageRows(table,all));
      const resumed=await createStoragePriceYearReader(source.db,storageRowKey(table,first.groups[0].at(-1)!))();
      expect(resumed.groups).toEqual(last.groups);expect(resumed.next).toBeUndefined();
    } finally {source.dispose();}
  });
  it("bounds sixteen complete years and retains the next year for a fresh checkpoint resume",async()=>{
    const source=createSqliteD1(),table=storageTable("alpaca_daily_bars");
    try {
      source.script(table.sql+";");
      const rows=Array.from({length:18},(_,index)=>({ticker:`TEST${String(index).padStart(2,"0")}`,date:"2026-09-08"}));
      await source.db.prepare(`INSERT INTO alpaca_daily_bars(feed,ticker,date,o,h,l,c)
        SELECT 'sip',json_extract(value,'$.ticker'),json_extract(value,'$.date'),10,10,10,10 FROM json_each(?)`).bind(JSON.stringify(rows)).run();
      const reader=createStoragePriceYearReader(source.db,null);
      const first=await reader(16);
      expect(first.groups).toHaveLength(16);expect(first.next?.ticker).toBe("TEST16");
      const resumed=await createStoragePriceYearReader(source.db,storageRowKey(table,first.groups.at(-1)!.at(-1)!))(16);
      expect(resumed.groups.map(group=>group[0].ticker)).toEqual(["TEST16","TEST17"]);
      expect(resumed.next).toBeUndefined();
      await expect(reader(17)).rejects.toThrow("storage-year-batch-invalid");
    } finally {source.dispose();}
  });
});

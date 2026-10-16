import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { Db } from "../src/db.js";
import { EngineControlConflict } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { startServer } from "../src/server.js";
import { Visitors } from "../src/visitors.js";

it("requires the owner key and a valid cat for entry resets, independently of the trainer", async () => {
  const db = new Db(":memory:"), token = "test-owner-key-with-at-least-24-characters";
  const reset = vi.fn((cat: string) => ({cat,entriesUsed:0,tradesToday:8,maxTradesPerDay:8}));
  const engine = {db,bus:new EventBus(db),visitors:new Visitors(db),snapshot:()=>({}),health:()=>({ok:true}),
    coachAdminToken:token,resetEntryLimit:reset};
  const server = startServer({profile:()=>({}),engine},0,"127.0.0.1");
  await once(server,"listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/controls/reset-entry-limit`;
  const post = (body: unknown, key?: string, type = "application/json") => fetch(url, {method:"POST",
    headers:{"content-type":type,...(key ? {authorization:`Bearer ${key}`} : {})},body:JSON.stringify(body)});
  try {
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url,{method:"OPTIONS"})).status).toBe(405);
    expect((await post({cat:"tiger"})).status).toBe(401);
    expect((await post({cat:"tiger"},"wrong-key")).status).toBe(401);
    expect((await post({cat:"tiger"},token,"text/plain")).status).toBe(415);
    for (const body of [{cat:"unknown"},{cat:"tiger",clearLoss:true},[],null])
      expect((await post(body,token)).status).toBe(400);
    expect((await post({cat:"x".repeat(1024)},token)).status).toBe(413);
    expect(reset).not.toHaveBeenCalled();
    for (const cat of ["tiger","mochi"]) {
      const response = await post({cat},token);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({cat,entriesUsed:0});
      expect(reset).toHaveBeenLastCalledWith(cat);
    }
    reset.mockImplementationOnce(() => {throw new EngineControlConflict("Entry limit is not exhausted.");});
    const conflict = await post({cat:"tiger"},token);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({error:"Entry limit is not exhausted."});
    engine.coachAdminToken = "";
    expect((await post({cat:"tiger"},token)).status).toBe(503);
    expect(reset).toHaveBeenCalledTimes(3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
});

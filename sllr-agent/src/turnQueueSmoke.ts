import assert from "node:assert/strict";
import { TurnQueue } from "./turnQueue.js";

const queue = new TurnQueue();
const events: string[] = [];

queue.enqueue("same-buyer", async () => {
  events.push("first:start");
  await sleep(30);
  events.push("first:end");
});

queue.enqueue("same-buyer", async () => {
  events.push("second:start");
  await sleep(1);
  events.push("second:end");
});

queue.enqueue("other-buyer", async () => {
  events.push("other:start");
  await sleep(1);
  events.push("other:end");
});

await sleep(80);

assert.deepEqual(events.filter((event) => event.startsWith("first") || event.startsWith("second")), [
  "first:start",
  "first:end",
  "second:start",
  "second:end",
]);
assert(events.includes("other:start"));
assert(events.includes("other:end"));

console.log("SLL-R turn queue smoke passed");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

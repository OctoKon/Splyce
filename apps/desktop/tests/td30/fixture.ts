import { mount } from "svelte";
import Td30Fixture from "./Td30Fixture.svelte";

const target = document.getElementById("app");
if (target) {
  mount(Td30Fixture, { target });
}

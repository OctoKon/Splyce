import { mount } from "svelte";
import SessionActionsFixture from "./SessionActionsFixture.svelte";

const target = document.getElementById("app");
if (target) {
  mount(SessionActionsFixture, { target });
}

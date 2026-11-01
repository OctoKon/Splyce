import { mount } from "svelte";
import PermissionModeFixture from "./PermissionModeFixture.svelte";

const target = document.getElementById("app");
if (target) {
  mount(PermissionModeFixture, { target });
}

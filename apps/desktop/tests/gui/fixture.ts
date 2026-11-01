import { mount } from "svelte";
import A11yFixture, { SCENARIOS, type Scenario } from "./A11yFixture.svelte";

const params = new URLSearchParams(window.location.search);
const requested = params.get("scenario");
const scenario: Scenario = SCENARIOS.includes(requested as Scenario)
  ? (requested as Scenario)
  : "states";

const target = document.getElementById("app");
if (target) {
  mount(A11yFixture, { target, props: { scenario } });
}

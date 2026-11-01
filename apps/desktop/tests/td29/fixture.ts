import { mount } from "svelte";
import Td29Fixture from "./Td29Fixture.svelte";
import { isTd29Case } from "./cases";

const params = new URLSearchParams(window.location.search);
const requested = params.get("case") ?? "d1-setup";
const caseName = isTd29Case(requested) ? requested : "d1-setup";

const target = document.getElementById("app");
if (target) {
  mount(Td29Fixture, { target, props: { case: caseName } });
}

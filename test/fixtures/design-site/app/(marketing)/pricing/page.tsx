// A thin page: on its own it is well under every density threshold. What it renders INSIDE is not.
import { Button } from "../../../components/ui/button";

export default function Pricing() {
  return (
    <section>
      <h1>Pricing</h1>
      <p>Two plans.</p>
      <ul>
        <li>Free</li>
        <li>Team</li>
      </ul>
      <Button />
    </section>
  );
}

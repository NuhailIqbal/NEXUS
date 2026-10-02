import { fireEvent, screen } from "@testing-library/react";

/** Open a SearchSelect by its label, type in its search box and choose the first match. */
export async function pick(label: string, search: string) {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.change(await screen.findByPlaceholderText(/^(Type|Search)/), { target: { value: search } });
  fireEvent.click((await screen.findAllByRole("option"))[0]);
}

/** Open a dropdown without a search box and choose the option with this exact text. */
export async function choose(label: string, option: string) {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

import { act, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { userLoadingAtom } from "@/lib/atoms/auth";
import AppReadyMarker from "../AppReadyMarker";

describe("AppReadyMarker", () => {
  afterEach(() => {
    delete document.documentElement.dataset.appReady;
  });

  it("marks the document only once the session is resolved, and renders nothing", () => {
    const store = createStore();
    store.set(userLoadingAtom, true);
    const { container } = render(
      <Provider store={store}>
        <AppReadyMarker />
      </Provider>,
    );
    expect(document.documentElement.dataset.appReady).toBeUndefined();
    expect(container).toBeEmptyDOMElement();

    act(() => store.set(userLoadingAtom, false));
    expect(document.documentElement.dataset.appReady).toBe("true");
  });
});

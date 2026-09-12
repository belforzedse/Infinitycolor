import { fireEvent, render, screen } from "@testing-library/react";

import Voice from "../Voice";

const mockUseAudioPlayer = {
  playing: false,
  currentTime: 30,
  error: null as string | null,
  audioDuration: 120,
  handlePlay: jest.fn(),
  seekTo: jest.fn(),
  getProgress: jest.fn(() => 25),
  formatTime: jest.fn(
    (time: number) => `${Math.floor(time / 60)}:${String(time % 60).padStart(2, "0")}`,
  ),
};

jest.mock("@/hooks/useAudioPlayer", () => ({
  useAudioPlayer: () => mockUseAudioPlayer,
}));

jest.mock("../Icons/PlayIcon", () => ({
  __esModule: true,
  default: () => <div data-testid="play-icon" />,
}));

jest.mock("../Icons/PauseIcon", () => ({
  __esModule: true,
  default: () => <div data-testid="pause-icon" />,
}));

describe("Voice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAudioPlayer.playing = false;
    mockUseAudioPlayer.currentTime = 30;
    mockUseAudioPlayer.error = null;
    mockUseAudioPlayer.audioDuration = 120;
    mockUseAudioPlayer.getProgress.mockReturnValue(25);
  });

  it("renders a responsive, left-to-right waveform player", () => {
    const { container } = render(<Voice audioSrc="/audio.mp3" label="راهنمای صوتی" />);

    expect(container.firstChild).toHaveAttribute("dir", "ltr");
    expect(container.firstChild).toHaveClass("w-full", "max-w-sm", "min-h-[52px]");
    expect(screen.getByRole("button", { name: "پخش راهنمای صوتی" })).toBeEnabled();
    expect(screen.getByRole("slider", { name: "موقعیت پخش راهنمای صوتی" })).toBeEnabled();
    expect(screen.getByTestId("voice-waveform").children).toHaveLength(26);
  });

  it("shows the correct play and pause labels", () => {
    const { rerender } = render(<Voice audioSrc="/audio.mp3" label="راهنمای صوتی" />);
    expect(screen.getByTestId("play-icon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "پخش راهنمای صوتی" })).toBeInTheDocument();

    mockUseAudioPlayer.playing = true;
    rerender(<Voice audioSrc="/audio.mp3" label="راهنمای صوتی" />);
    expect(screen.getByTestId("pause-icon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "توقف راهنمای صوتی" })).toBeInTheDocument();
  });

  it("plays on activation and exposes a 44px focusable control", () => {
    render(<Voice audioSrc="/audio.mp3" label="راهنمای صوتی" />);
    const playButton = screen.getByRole("button", { name: "پخش راهنمای صوتی" });

    fireEvent.click(playButton);
    expect(mockUseAudioPlayer.handlePlay).toHaveBeenCalledTimes(1);
    expect(playButton).toHaveAttribute("data-aq-motion-sensitive");
    expect(playButton).toHaveClass("h-11", "w-11", "focus-visible:ring-2");
  });

  it("shows a disabled loading state until metadata is ready", () => {
    mockUseAudioPlayer.audioDuration = 0;
    render(<Voice audioSrc="/audio.mp3" label="راهنمای صوتی" />);

    expect(screen.getByRole("button", { name: "در حال بارگذاری راهنمای صوتی" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "موقعیت پخش راهنمای صوتی" })).toBeDisabled();
    expect(screen.getByRole("button").closest("div[aria-busy]")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("renders a concise failure state without inactive controls", () => {
    mockUseAudioPlayer.error = "پخش فایل صوتی در دسترس نیست.";
    render(<Voice audioSrc="/audio.mp3" />);

    expect(screen.getByRole("status")).toHaveTextContent("پخش فایل صوتی در دسترس نیست.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("colors waveform bars from playback progress and disables their motion when requested", () => {
    mockUseAudioPlayer.getProgress.mockReturnValue(50);
    render(<Voice audioSrc="/audio.mp3" />);

    const bars = Array.from(screen.getByTestId("voice-waveform").children);
    expect(bars.filter((bar) => bar.getAttribute("data-active") === "true")).toHaveLength(13);
    expect(bars[0]).toHaveAttribute("data-aq-motion-sensitive");
    expect(bars[0]).toHaveClass("bg-infinity-primary", "motion-reduce:transition-none");
    expect(bars[25]).toHaveClass("bg-slate-300");
  });

  it("supports pointer-native range changes and keyboard seeking", () => {
    render(<Voice audioSrc="/audio.mp3" label="راهنمای صوتی" />);
    const slider = screen.getByRole("slider", { name: "موقعیت پخش راهنمای صوتی" });

    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "120");
    expect(slider).toHaveAttribute("value", "30");
    expect(slider).toHaveAttribute("aria-valuetext", "0:30 از 2:00");

    fireEvent.change(slider, { target: { value: "48" } });
    expect(mockUseAudioPlayer.seekTo).toHaveBeenCalledWith(48);

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.keyDown(slider, { key: "Home" });
    fireEvent.keyDown(slider, { key: "End" });
    expect(mockUseAudioPlayer.seekTo).toHaveBeenNthCalledWith(2, 35);
    expect(mockUseAudioPlayer.seekTo).toHaveBeenNthCalledWith(3, 25);
    expect(mockUseAudioPlayer.seekTo).toHaveBeenNthCalledWith(4, 0);
    expect(mockUseAudioPlayer.seekTo).toHaveBeenNthCalledWith(5, 120);
  });

  it("displays the formatted duration and accepts layout classes", () => {
    mockUseAudioPlayer.audioDuration = 125;
    render(<Voice audioSrc="/audio.mp3" className="mt-6" />);

    expect(screen.getByText("2:05")).toBeInTheDocument();
    expect(screen.getByRole("button").closest("div[dir='ltr']")).toHaveClass("mt-6");
  });
});

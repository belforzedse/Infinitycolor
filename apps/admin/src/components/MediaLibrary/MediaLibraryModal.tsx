"use client";

import Modal from "@/components/Kits/Modal";
import MediaLibraryPanel, { type MediaLibraryPanelProps } from "./MediaLibraryPanel";

interface MediaLibraryModalProps extends Omit<MediaLibraryPanelProps, "onCancel"> {
  isOpen: boolean;
  onClose: () => void;
  title: string;
}

/**
 * Picker over the catalog media library (product images plus unattached uploads).
 * The panel only exists while open, so a previous search or selection never carries
 * over to the next pick.
 */
export default function MediaLibraryModal({
  isOpen,
  onClose,
  title,
  ...panelProps
}: MediaLibraryModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} className="max-w-5xl" contentClassName="p-0">
      {isOpen ? <MediaLibraryPanel {...panelProps} onCancel={onClose} /> : null}
    </Modal>
  );
}

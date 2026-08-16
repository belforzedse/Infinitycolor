import type { TabItem } from "@/types/Tabs";
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from "@headlessui/react";
import type { ReactNode } from "react";

interface TabsProps {
  tabs: TabItem[];
  children: ReactNode[];
  tabsClassName?: string;
}

export default function Tabs({ tabs, children, tabsClassName }: TabsProps) {
  return (
    <div className="w-full">
      <TabGroup>
        <TabList className="grid grid-cols-3 gap-2 border-gray-200 lg:flex lg:gap-5 lg:border-b">
          {tabs.map(({ key, value }) => (
            <Tab
              key={key}
              className={({ selected }) =>
                `rounded-compact py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 lg:rounded-b-none lg:rounded-t-control lg:text-base ${tabsClassName} ${
                  selected
                    ? "border border-blue-600 bg-blue-50 text-blue-600 lg:border-b-2 lg:border-l-0 lg:border-r-0 lg:border-t-0 lg:border-infinity-primary lg:bg-white lg:text-slate-700"
                    : "border border-slate-200 bg-slate-50 text-slate-400 lg:border-none lg:bg-white"
                }`
              }
            >
              {value}
            </Tab>
          ))}
        </TabList>
        <TabPanels className="mt-5 lg:mt-4">
          {children.map((child, index) => (
            <TabPanel key={tabs[index].key} className="rounded-prominent">
              {child}
            </TabPanel>
          ))}
        </TabPanels>
      </TabGroup>
    </div>
  );
}

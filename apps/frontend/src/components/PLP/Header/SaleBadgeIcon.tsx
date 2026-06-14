type Props = {
  className?: string;
};

export default function SaleBadgeIcon({ className }: Props) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      data-testid="sale-badge-icon"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3.495 13.464L4.69 15.028L4.948 16.975C5.091 18.055 5.94 18.905 7.02 19.049L8.972 19.31L10.535 20.504C11.4 21.165 12.599 21.165 13.464 20.504L15.028 19.309H15.026L16.974 19.051C18.054 18.908 18.904 18.059 19.048 16.979L19.308 15.027C19.308 15.027 19.912 14.237 20.503 13.464C21.164 12.599 21.163 11.4 20.503 10.535L19.31 8.971L19.052 7.024C18.909 5.944 18.06 5.094 16.98 4.95L15.027 4.69L13.464 3.496C12.599 2.835 11.4 2.835 10.535 3.496L8.971 4.69H8.973L7.025 4.949C5.945 5.092 5.095 5.941 4.951 7.021L4.69 8.973C4.69 8.973 4.086 9.763 3.495 10.536C2.835 11.4 2.835 12.6 3.495 13.464Z"
        fill="#FACC15"
        stroke="#FACC15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.89893 14.1L14.0989 9.9"
        stroke="white"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.2891 13.953C14.3831 14.047 14.3831 14.199 14.2891 14.292C14.1951 14.386 14.0431 14.386 13.9501 14.292C13.8561 14.198 13.8561 14.046 13.9501 13.953C14.0431 13.859 14.1951 13.859 14.2891 13.953"
        stroke="white"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.0488 9.708C10.1428 9.802 10.1428 9.954 10.0488 10.047C9.95477 10.141 9.80277 10.141 9.70977 10.047C9.61677 9.953 9.61577 9.801 9.70977 9.708C9.80377 9.615 9.95577 9.614 10.0488 9.708"
        stroke="white"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

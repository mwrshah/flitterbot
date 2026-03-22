export const seo = ({ title, description }: { title: string; description?: string }) => {
  return [
    { title },
    { name: "description", content: description },
    { name: "og:type", content: "website" },
    { name: "og:title", content: title },
    { name: "og:description", content: description },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
  ];
};

// Fixture for the CI job that runs the Harbyn GitHub Action for real (.github/workflows/ci.yml, job "action").
export const reply = (client: { create: (o: object) => unknown }) => client.create({ model: "acme-1" });

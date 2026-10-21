import { User } from "../../database/models.js";
import { escapeRegex } from "../../utils/pagination.js";
export async function findContacts(
  viewerId: string,
  search: string,
  limit: number,
  cursor?: { id: string; name: string },
) {
  const match: object[] = [
    { status: "active", verified: true, _id: { $ne: viewerId } },
  ];
  if (search)
    match.push({
      $or: [
        { name: { $regex: escapeRegex(search), $options: "i" } },
        { email: search.toLowerCase() },
      ],
    });
  if (cursor)
    match.push({
      $or: [
        { name: { $gt: cursor.name } },
        { name: cursor.name, _id: { $gt: cursor.id } },
      ],
    });
  return User.aggregate<{ _id: string; name: string }>([
    { $match: { $and: match } },
    { $sort: { name: 1, _id: 1 } },
    {
      $lookup: {
        from: "blocks",
        let: { target: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  {
                    $and: [
                      { $eq: ["$ownerId", viewerId] },
                      { $eq: ["$targetId", "$$target"] },
                    ],
                  },
                  {
                    $and: [
                      { $eq: ["$targetId", viewerId] },
                      { $eq: ["$ownerId", "$$target"] },
                    ],
                  },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "blocked",
      },
    },
    { $match: { "blocked.0": { $exists: false } } },
    { $limit: limit + 1 },
    { $project: { _id: 1, name: 1 } },
  ]);
}

import aiosqlite

from services.jwt_service import create_access_token


def _create_user(db_path: str, username: str, tag: str, email: str) -> dict:
    async def _inner():
        async with aiosqlite.connect(db_path) as db:
            await db.execute(
            """
            INSERT INTO users (username, tag, email, password_hash, is_verified, is_banned, is_admin)
            VALUES (?, ?, ?, 'x', 1, 0, 0)
            """,
            (username, tag, email),
            )
            await db.commit()
            async with db.execute(
                "SELECT id, username, tag FROM users WHERE email = ?", (email,)
            ) as cur:
                row = await cur.fetchone()
        return {"id": row[0], "username": row[1], "tag": row[2]}

    import asyncio

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_inner())
    finally:
        loop.close()


def test_create_group_by_tags_and_invite_join(client, monkeypatch):
    import database as db_mod

    # Arrange users
    owner = _create_user(db_mod.DB_PATH, "Owner", "owner_tag", "owner@test.local")
    _create_user(db_mod.DB_PATH, "Member", "member_tag", "member@test.local")
    joiner = _create_user(db_mod.DB_PATH, "Joiner", "joiner_tag", "joiner@test.local")

    owner_token = create_access_token(owner["id"], owner["username"], owner["tag"], False)
    joiner_token = create_access_token(joiner["id"], joiner["username"], joiner["tag"], False)

    # Create group via tags
    res = client.post(
        "/api/groups",
        headers={"Authorization": f"Bearer {owner_token}"},
        json={"title": "Test Group", "member_tags": ["member_tag"]},
    )
    assert res.status_code == 201, res.text
    group = res.json()
    assert group["members_added"] == 1
    group_id = group["id"]

    # Create invite
    inv = client.post(
        f"/api/groups/{group_id}/invite",
        headers={"Authorization": f"Bearer {owner_token}", "X-Correlation-Id": "test-corr"},
    )
    assert inv.status_code == 200, inv.text
    invite = inv.json()
    assert "code" in invite and invite["code"]

    # Join by invite (POST alias expected by frontend)
    join = client.post(
        f"/api/groups/invite/{invite['code']}",
        headers={"Authorization": f"Bearer {joiner_token}", "X-Correlation-Id": "test-corr-2"},
    )
    assert join.status_code == 200, join.text
    payload = join.json()
    assert payload["group_id"] == group_id
    assert payload["title"] == "Test Group"


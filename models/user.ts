import * as TypeORM from "typeorm";
import Model from "./common";

declare var syzoj, ErrorMessage: any;

import JudgeState from "./judge_state";
import UserPrivilege from "./user_privilege";
import Article from "./article";
import TodoList from "./todo-list";
import UserRestriction from "./user-restriction";

@TypeORM.Entity()
export default class User extends Model {
  static cache = true;

  @TypeORM.PrimaryGeneratedColumn()
  id: number;

  @TypeORM.Index({ unique: true })
  @TypeORM.Column({ nullable: true, type: "varchar", length: 80 })
  username: string;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 120 })
  email: string;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 120 })
  password: string;

  @TypeORM.Column({ nullable: true, type: "varchar", length: 80 })
  nickname: string;

  @TypeORM.Column({ nullable: true, type: "text" })
  nameplate: string;

  @TypeORM.Column({ nullable: true, type: "text" })
  information: string;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "integer" })
  ac_num: number;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "integer" })
  submit_num: number;

  @TypeORM.Column({ nullable: true, type: "boolean" })
  is_admin: boolean;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "boolean" })
  is_show: boolean;

  @TypeORM.Index()
  @TypeORM.Column({ nullable: true, type: "boolean" })
  is_rated: boolean;

  @TypeORM.Column({ nullable: true, type: "boolean", default: true })
  public_email: boolean;

  @TypeORM.Column({ nullable: true, type: "boolean", default: true })
  prefer_formatted_code: boolean;

  @TypeORM.Column({ nullable: true, type: "boolean", default: true })
  auto_spacing_page: boolean;

  @TypeORM.Column({ nullable: true, type: "boolean", default: true })
  can_see_quote: boolean;

  @TypeORM.Column({ nullable: true, type: "integer" })
  sex: number;

  @TypeORM.Column({ nullable: true, type: "integer" })
  rating: number;

  @TypeORM.Column({ nullable: true, type: "integer" })
  register_time: number;

  privilege_cache?: Map<string, boolean>;

  static async fromEmail(email): Promise<User> {
    return User.findOne({
      where: {
        email: email
      }
    });
  }

  static async fromName(name): Promise<User> {
    return User.findOne({
      where: {
        username: name
      }
    });
  }

  async isAllowedEditBy(user) {
    if (!user) return false;
    if (await user.hasPrivilege('manage_user')) return true;
    return user && (user.is_admin || this.id === user.id);
  }

  getQueryBuilderForACProblems() {
    return JudgeState.createQueryBuilder()
                     .select(`DISTINCT(problem_id)`)
                     .where('user_id = :user_id', { user_id: this.id })
                     .andWhere('status = :status', { status: 'Accepted' })
                     .orderBy({ problem_id: 'ASC' })
  }

  async refreshSubmitInfo() {
    await syzoj.utils.lock(['User::refreshSubmitInfo', this.id], async () => {
      this.ac_num = await JudgeState.countQuery(this.getQueryBuilderForACProblems());
      this.submit_num = await JudgeState.count({
        user_id: this.id,
        type: TypeORM.Not(1) // Not a contest submission
      });

      await this.save();
    });
  }

  async getACProblems() {
    let queryResult = await this.getQueryBuilderForACProblems().getRawMany();

    return queryResult.map(record => record['problem_id'])
  }

  async getArticles() {
    return await Article.find({
      where: {
        user_id: this.id
      }
    });
  }

  async getStatistics() {
    let statuses = {
      "Accepted": ["Accepted"],
      "Wrong Answer": ["Wrong Answer", "File Error", "Output Limit Exceeded"],
      "Runtime Error": ["Runtime Error"],
      "Time Limit Exceeded": ["Time Limit Exceeded"],
      "Memory Limit Exceeded": ["Memory Limit Exceeded"],
      "Compile Error": ["Compile Error"]
    };

    let res = {};
    for (let status in statuses) {
      res[status] = 0;
      for (let s of statuses[status]) {
        res[status] += await JudgeState.count({
          user_id: this.id,
          type: 0,
          status: s
        });
      }
    }

    return res;
  }

  async getTodoList(): Promise<number[]> {
    let todoList =  await TodoList.find({
      where: { user_id: this.id }
    });
    return todoList.map((item) => item.problem_id);
  }

  async renderInformation() {
    this.information = await syzoj.utils.markdown(this.information);
  }

  ensurePrivilegeCache(): Map<string, boolean> {
    return this.privilege_cache = this.privilege_cache || new Map();
  }

  async getPrivileges(): Promise<string[]> {
    let privileges = await UserPrivilege.find({
      where: {
        user_id: this.id
      }
    });

    const results = privileges.map(x => x.privilege);
    this.privilege_cache = new Map(results.map(privilege => [privilege, true]));
    return results;
  }

  async setPrivileges(newPrivileges: string[]) {
    let oldPrivileges = await this.getPrivileges();

    let delPrivileges = oldPrivileges.filter(x => !newPrivileges.includes(x));
    let addPrivileges = newPrivileges.filter(x => !oldPrivileges.includes(x));

    for (let privilege of delPrivileges) {
      let obj = await UserPrivilege.findOne({ where: {
        user_id: this.id,
        privilege: privilege
      } });

      await obj.destroy();
      this.privilege_cache.set(privilege, false);
    }

    for (let privilege of addPrivileges) {
      let obj = await UserPrivilege.create({
        user_id: this.id,
        privilege: privilege
      });

      await obj.save();
      this.privilege_cache.set(privilege, true);
    }
  }

  async hasPrivilege(privilege): Promise<boolean> {
    if (this.is_admin) return true;
    if (this.ensurePrivilegeCache().has(privilege)) return this.privilege_cache.get(privilege);

    const x = await UserPrivilege.findOne({ where: { user_id: this.id, privilege: privilege } });
    const result = !!x;
    this.privilege_cache.set(privilege, result);
    return result;
  }

  async isRestricted(restriction: string): Promise<boolean> {
    if (this.is_admin) return false;

    const item = await UserRestriction.findOne({
      where: { user_id: this.id, restriction }
    });
    return !!item;
  }

  async checkRestricted(restriction: string, messageTemplate?: string): Promise<void> {
    if (this.is_admin) return;

    const item = await UserRestriction.findOne({
      where: { user_id: this.id, restriction }
    });

    if (item) {
      messageTemplate = messageTemplate || '您被禁止使用此功能，原因：{reason}';
      const message = messageTemplate.replace('{reason}', item.reason);
      throw new ErrorMessage(message);
    }
  }

  async getLastSubmitLanguage() {
    let a = await JudgeState.findOne({
      where: {
        user_id: this.id
      },
      order: {
        submit_time: 'DESC'
      }
    });
    if (a) return a.language;

    return null;
  }
}

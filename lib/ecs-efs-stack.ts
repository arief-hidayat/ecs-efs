import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secrets_manager from 'aws-cdk-lib/aws-secretsmanager';
import { Duration } from 'aws-cdk-lib';

interface EfsMountMapping {
  efsPath: string
  containerPath: string
  sourceVolume: string 
}
interface EfsMount {
  efsId?: string
  efsSecurityGroupId?: string
  mountMapping: EfsMountMapping[] 
}
interface Asg {
  instanceType: ec2.InstanceType
  machineImage: ec2.IMachineImage
  desiredCapacity: number
  cooldown: Duration
}
interface EcsContainer {
  // imageTag: string
  // containerPort: number
  options: ecs.ContainerDefinitionOptions
  efsMount?: EfsMount
}
interface Alb {
  albName: string,
  listenerProps: elbv2.BaseApplicationListenerProps,
  targetProps: elbv2.AddApplicationTargetsProps
}
interface EcsSvc {
  svcName: string
  desiredCount: number
  placementStrategies: ecs.PlacementStrategy[]
  maxHealthyPercent?: number,
  minHealthyPercent?: number,
  cntr: EcsContainer
  autoscaling?: AutoscaleTask
  alb: Alb
}
interface ReqCountOpts {
  requestsPerTarget: number,
  scaleInCooldown?: cdk.Duration,
  scaleOutCooldown?: cdk.Duration,
}
interface AutoscaleTask {
  min: number,
  max: number,
  cpuOpts?: ecs.CpuUtilizationScalingProps,
  requestCountOpts?: ReqCountOpts
}

interface EcsEfsStackProps extends cdk.StackProps {
  vpcName: string
  asg: Asg
  services: EcsSvc[]
}

export class EcsEfsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsEfsStackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'dev-vpc', {vpcName: props.vpcName});
    // ECS cluster on EC2 with cluster ASG capacity provider
    const ecsCluster = new ecs.Cluster(this, 'ecs-cluster', {vpc: vpc, containerInsights: true});
    const asg = new autoscaling.AutoScalingGroup(this, 'ecs-asg', {
      instanceType: props.asg.instanceType,
      machineImage: props.asg.machineImage,
      desiredCapacity: props.asg.desiredCapacity,
      cooldown: props.asg.cooldown,
      vpc,
    });
    const capacityProvider = new ecs.AsgCapacityProvider(this, 'asg-capacity-provider', { autoScalingGroup: asg });
    ecsCluster.addAsgCapacityProvider(capacityProvider);

    // security groups
    const dbSG = new ec2.SecurityGroup(this, 'DBSG', { vpc });
    const appSG = new ec2.SecurityGroup(this, 'AppSG', { vpc });
    const lbSG = new ec2.SecurityGroup(this, 'LBSG', { vpc });
    dbSG.addIngressRule(ec2.Peer.securityGroupId(appSG.securityGroupId), ec2.Port.tcp(3306));
    appSG.addIngressRule(ec2.Peer.securityGroupId(lbSG.securityGroupId), ec2.Port.tcp(80));

    const albMap: { [id: string]: elbv2.ApplicationListener; } = {};

    // services
    props.services.forEach((svc) => {
      const cntr = svc.cntr
      const efsList:efs.FileSystem[] = []
      // task definition
      const taskDef = new ecs.Ec2TaskDefinition(this, `task-def-${svc.svcName}`, {
        networkMode: ecs.NetworkMode.AWS_VPC
      });

      // prepare EFS if specified
      if (cntr.efsMount) {
        const efsSg = cntr.efsMount.efsSecurityGroupId ? 
          ec2.SecurityGroup.fromSecurityGroupId(this, `efs-sg-${svc.svcName}`, cntr.efsMount.efsSecurityGroupId, { allowAllOutbound: false }): 
          new ec2.SecurityGroup(this, `efs-sg-${svc.svcName}`, { vpc: vpc, allowAllOutbound: false, description: 'Security group used by EFS'});
        const fileSystem = cntr.efsMount.efsId ?
        efs.FileSystem.fromFileSystemAttributes(this, `ecs-efs-${svc.svcName}`, { fileSystemId: cntr.efsMount.efsId, securityGroup: efsSg }): 
        new efs.FileSystem(this, `ecs-efs-${svc.svcName}`, {
          vpc: vpc, encrypted: true, lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS, 
          performanceMode: efs.PerformanceMode.GENERAL_PURPOSE, throughputMode: efs.ThroughputMode.BURSTING
        });
        cntr.efsMount.mountMapping.forEach((mapping) => {
        const efsAccessPoint = new efs.AccessPoint(this, `efs-ap-${svc.svcName}`, {fileSystem: fileSystem, path: mapping.efsPath});
        efsAccessPoint.node.addDependency(fileSystem);
        const efsMountPolicy = new iam.PolicyStatement({
          actions: [
              'elasticfilesystem:ClientMount',
              // 'elasticfilesystem:ClientWrite',
              // 'elasticfilesystem:ClientRootAccess'
          ], 
          resources: [
              efsAccessPoint.accessPointArn,
              fileSystem.fileSystemArn
          ]
        })
        taskDef.addToTaskRolePolicy(efsMountPolicy)
        taskDef.addToExecutionRolePolicy(efsMountPolicy)
        taskDef.addVolume({
          name: mapping.sourceVolume,
          efsVolumeConfiguration: {
              fileSystemId: fileSystem.fileSystemId,
              transitEncryption: 'ENABLED',
              authorizationConfig: {
                  accessPointId: efsAccessPoint.accessPointId,
              }
          },
        });
      });
      }
      // container definition
      const containerDef = taskDef.addContainer(`cntr-${svc.svcName}`, {
        ...cntr.options,
        logging: new ecs.AwsLogDriver({
          streamPrefix: svc.svcName,
        })
      })
      // mount EFS if specified
      if (cntr.efsMount) {
        cntr.efsMount.mountMapping.forEach((mapping) => 
          containerDef.addMountPoints({
            containerPath: mapping.containerPath,
            sourceVolume: mapping.sourceVolume,
            readOnly: false,
          })
        );
      }
      // ecs service on EC2
    const albService = new ecs.Ec2Service(this, `alb-svc-${svc.svcName}`, {
      cluster: ecsCluster,
      taskDefinition: taskDef,
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [appSG],
      desiredCount: svc.desiredCount,
      placementStrategies: svc.placementStrategies,
      maxHealthyPercent: svc.maxHealthyPercent || 200,
      minHealthyPercent: svc.minHealthyPercent || 50,
    });
    // albService.node.addDependency(rdsInstance);
    const albObj: Alb = svc.alb
    // create new ALB or reuse
    if(!albMap[albObj.albName]) {
      const lb = new elbv2.ApplicationLoadBalancer(this, albObj.albName, { vpc, internetFacing: true, securityGroup: lbSG });
      const lbListener = lb.addListener(`listener-${svc.svcName}`, { ...albObj.listenerProps, port: 80 });
      new cdk.CfnOutput(this, `ecsLbDnsName-${albObj.albName}`, {
        value: lb.loadBalancerDnsName,
        description: 'ECS Load Balancer DNS Name',
      });
      albMap[albObj.albName] = lbListener
    }
    // create ALB target
    const targetGroup = albMap[albObj.albName].addTargets(`tg-${svc.svcName}`, {
      ...albObj.targetProps,
      port: 80,
      targetGroupName: `tg-${svc.svcName}`,
      targets: [albService.loadBalancerTarget({ containerName: `cntr-${svc.svcName}` })],
    });

    // setup task autoscaling
      if(svc.autoscaling) {
        const scaling = albService.autoScaleTaskCount({ minCapacity: svc.autoscaling.min, maxCapacity: svc.autoscaling.max });
        if(svc.autoscaling.cpuOpts) {
          scaling.scaleOnCpuUtilization(`cpu-scaling-${svc.svcName}`, svc.autoscaling.cpuOpts);
        } else if(svc.autoscaling.requestCountOpts) {
          const reqCountOpts: ecs.RequestCountScalingProps = {
            requestsPerTarget: svc.autoscaling.requestCountOpts.requestsPerTarget,
            scaleInCooldown: svc.autoscaling.requestCountOpts.scaleInCooldown,
            scaleOutCooldown: svc.autoscaling.requestCountOpts.scaleOutCooldown,
            targetGroup: targetGroup
          }
          scaling.scaleOnRequestCount(`req-count-scaling-${svc.svcName}`, reqCountOpts)
        }
      }

      efsList.forEach( (fileSystem, i) => {
        fileSystem.connections.allowDefaultPortFrom(albService.connections)
        new cdk.CfnOutput(this, `ecsEfsArn-${svc.svcName}-${i}`, {
          value: fileSystem.fileSystemArn,
          description: `ECS EFS ARN ${i}`,
        });
        new cdk.CfnOutput(this, `ecsEfsId-${svc.svcName}-${i}`, {
          value: fileSystem.fileSystemId,
          description: `ECS EFS Id ${i}`,
        });
      })
    })
  }
}
